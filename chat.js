(function () {
  const TOKEN_URL = window.JACK_CHAT_API_URL || "";
  const STORAGE_KEY = "jackVoiceConversation.v1";
  const MAX_TURNS = 40;

  function loadHistory() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.slice(-MAX_TURNS) : [];
    } catch {
      return [];
    }
  }

  function saveHistory(turns) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(turns.slice(-MAX_TURNS)));
    } catch {
      /* private mode / quota */
    }
  }

  function ensureUi() {
    let root = document.getElementById("jack-voice");
    if (root) return root;

    const leftover = document.getElementById("voice-mount");
    if (leftover) leftover.remove();

    root = document.createElement("div");
    root.id = "jack-voice";
    root.className = "voice-dock";
    root.innerHTML = `
      <button type="button" class="talk-cta" id="talk-cta" aria-pressed="false" aria-label="Start AI voice assistant about Jack">
        <span class="talk-cta__orb" id="chatbot-orb" aria-hidden="true"></span>
        <span class="talk-cta__label" id="talk-cta-label">Ask AI</span>
      </button>
      <p class="chatbot__status visually-hidden" id="chatbot-status" aria-live="polite">Tap the sphere, allow the microphone, then speak.</p>
      <button type="button" class="chatbot__end" id="chatbot-end" hidden>End conversation</button>
      <audio id="chatbot-audio" autoplay playsinline></audio>
    `;
    document.body.appendChild(root);
    return root;
  }

  const root = ensureUi();
  const launch = document.getElementById("talk-cta");
  const statusEl = document.getElementById("chatbot-status");
  const endBtn = document.getElementById("chatbot-end");
  const orb = document.getElementById("chatbot-orb");
  const audioEl = document.getElementById("chatbot-audio");
  const labelEl = document.getElementById("talk-cta-label");

  if (!launch || !statusEl || !endBtn || !orb || !audioEl) return;

  let history = loadHistory();
  let pc = null;
  let dc = null;
  let localStream = null;
  let active = false;
  let starting = false;
  let contextSent = false;
  let speakingHold = null;

  function setStatus(text, state) {
    statusEl.textContent = text;
    orb.dataset.state = state || "idle";
    root.dataset.state = state || "idle";
  }

  function clearSpeakingHold() {
    if (speakingHold) {
      clearTimeout(speakingHold);
      speakingHold = null;
    }
  }

  function markSpeaking() {
    clearSpeakingHold();
    setStatus("Speaking", "speaking");
    if (labelEl && active) labelEl.textContent = "Tap to end";
  }

  function scheduleListening(delayMs) {
    clearSpeakingHold();
    speakingHold = setTimeout(() => {
      speakingHold = null;
      if (!active) return;
      setStatus("Listening", "listening");
      if (labelEl) labelEl.textContent = "Tap to end";
    }, delayMs);
  }

  function rememberTurn(role, text) {
    if (!text) return;
    history.push({ role, text, at: Date.now() });
    saveHistory(history);
  }

  function priorContextMessage() {
    if (!history.length) return null;
    const lines = history
      .slice(-12)
      .map((t) => `${t.role === "user" ? "Visitor" : "Assistant"}: ${t.text}`)
      .join("\n");
    return (
      "Continue this same visit’s conversation. Prior turns (do not read aloud unless asked):\n" +
      lines
    );
  }

  function sendPriorContext() {
    if (contextSent || !dc || dc.readyState !== "open") return;
    const text = priorContextMessage();
    if (!text) return;
    contextSent = true;
    dc.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      })
    );
  }

  async function fetchEphemeralKey() {
    if (!TOKEN_URL) {
      throw new Error(
        "Voice assistant isn’t connected yet. Set JACK_CHAT_API_URL to your token endpoint."
      );
    }
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || "Could not start a ChatGPT voice session.");
    }
    const key = data.value || data.client_secret?.value;
    if (!key) throw new Error("Missing ephemeral token from server.");
    return key;
  }

  function handleServerEvent(event) {
    switch (event.type) {
      case "session.created":
      case "session.updated":
        clearSpeakingHold();
        setStatus("Listening", "listening");
        break;
      case "input_audio_buffer.speech_started":
        clearSpeakingHold();
        setStatus("Listening", "listening");
        break;
      case "input_audio_buffer.speech_stopped":
        clearSpeakingHold();
        setStatus("Thinking", "thinking");
        break;
      case "response.created":
      case "response.output_audio.delta":
      case "response.audio.delta":
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        markSpeaking();
        // Keep the glow alive between chunks / buffered playback.
        scheduleListening(2500);
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) rememberTurn("user", event.transcript);
        break;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        if (event.transcript) rememberTurn("assistant", event.transcript);
        // Don't drop speaking yet — audio often keeps playing after transcript ends.
        break;
      case "response.output_audio.done":
      case "response.audio.done":
        markSpeaking();
        scheduleListening(3000);
        break;
      case "response.done":
        // Grace period so buffered WebRTC audio can finish playing.
        markSpeaking();
        scheduleListening(3500);
        break;
      case "error":
        clearSpeakingHold();
        setStatus(event.error?.message || "Voice error", "error");
        if (labelEl) labelEl.textContent = "Try again";
        break;
      default:
        break;
    }
  }

  async function startConversation() {
    if (active || starting) return;
    if (
      !window.isSecureContext &&
      location.hostname !== "localhost" &&
      location.hostname !== "127.0.0.1"
    ) {
      setStatus("Needs HTTPS", "error");
      if (labelEl) labelEl.textContent = "Needs HTTPS";
      return;
    }

    starting = true;
    contextSent = false;
    launch.disabled = true;
    launch.classList.add("is-active");
    launch.setAttribute("aria-pressed", "true");
    root.classList.add("is-open");
    if (labelEl) labelEl.textContent = "Connecting…";
    setStatus("Connecting", "connecting");

    try {
      const ephemeralKey = await fetchEphemeralKey();

      pc = new RTCPeerConnection();
      audioEl.srcObject = null;

      pc.ontrack = (e) => {
        audioEl.srcObject = e.streams[0];
      };

      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

      dc = pc.createDataChannel("oai-events");
      dc.addEventListener("open", () => {
        sendPriorContext();
      });
      dc.addEventListener("message", (e) => {
        try {
          handleServerEvent(JSON.parse(e.data));
        } catch {
          /* ignore */
        }
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      await new Promise((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        const check = () => {
          if (pc.iceGatheringState === "complete") {
            pc.removeEventListener("icegatheringstatechange", check);
            resolve();
          }
        };
        pc.addEventListener("icegatheringstatechange", check);
        setTimeout(resolve, 1500);
      });

      const sdp = pc.localDescription?.sdp || offer.sdp;
      const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: sdp,
        headers: {
          Authorization: `Bearer ${ephemeralKey}`,
          "Content-Type": "application/sdp",
        },
      });

      if (!sdpResponse.ok) {
        const errText = await sdpResponse.text();
        throw new Error(errText || "ChatGPT voice connection failed.");
      }

      const answer = { type: "answer", sdp: await sdpResponse.text() };
      await pc.setRemoteDescription(answer);

      active = true;
      endBtn.hidden = false;
      launch.setAttribute("aria-label", "End AI voice conversation");
      if (labelEl) labelEl.textContent = "Tap to end";
      setStatus("Listening", "listening");
      if (dc && dc.readyState === "open") sendPriorContext();
    } catch (err) {
      console.error(err);
      setStatus(err.message || "Could not start voice chat.", "error");
      if (labelEl) labelEl.textContent = "Try again";
      stopConversation(false);
    } finally {
      starting = false;
      launch.disabled = false;
    }
  }

  function stopConversation(resetStatus = true) {
    active = false;
    starting = false;
    contextSent = false;
    clearSpeakingHold();
    if (dc) {
      try {
        dc.close();
      } catch {
        /* ignore */
      }
    }
    dc = null;
    if (pc) {
      try {
        pc.getSenders().forEach((s) => s.track && s.track.stop());
        pc.close();
      } catch {
        /* ignore */
      }
    }
    pc = null;
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    audioEl.srcObject = null;
    endBtn.hidden = true;
    launch.classList.remove("is-active");
    launch.setAttribute("aria-pressed", "false");
    launch.setAttribute("aria-label", "Start AI voice assistant about Jack");
    launch.disabled = false;
    if (labelEl) labelEl.textContent = "Ask AI";
    if (resetStatus) setStatus("Ready", "idle");
  }

  launch.addEventListener("click", () => {
    if (starting) return;
    if (active) {
      stopConversation(true);
      return;
    }
    startConversation();
  });
  endBtn.addEventListener("click", () => stopConversation(true));

  window.addEventListener("pagehide", () => {
    if (active) stopConversation(false);
  });
})();
