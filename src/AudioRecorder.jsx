import { useState, useRef } from "react";

const mimeType = "audio/webm";

const AudioRecorder = () => {
  const [permission, setPermission] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState("inactive");
  const [stream, setStream] = useState(null);
  const [audioBlob, setAudioBlob] = useState(null);
  const [audioChunks, setAudioChunks] = useState([]);

  const mediaRecorder = useRef(null);
  const websocketRef = useRef(null);

  const getMicrophonePermission = async () => {
    if ("MediaRecorder" in window) {
      try {
        const mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
        setPermission(true);
        setStream(mediaStream);

        // Initialize WebSocket
        websocketRef.current = new WebSocket("ws://localhost:3000/ws");

        websocketRef.current.onopen = () => {
          console.log("Connected to WebSocket server.");
        };

        websocketRef.current.onmessage = (event) => {
          handleServerMessage(event.data);
        };

        websocketRef.current.onerror = (err) => {
          console.error("WebSocket error:", err);
        };

        websocketRef.current.onclose = () => {
          console.log("WebSocket connection closed.");
        };
      } catch (err) {
        alert(err.message);
      }
    } else {
      alert("The MediaRecorder API is not supported in your browser.");
    }
  };

  const startRecording = () => {
    setRecordingStatus("recording");
    const media = new MediaRecorder(stream, { mimeType });

    mediaRecorder.current = media;
    mediaRecorder.current.start();

    const localAudioChunks = [];
    mediaRecorder.current.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        localAudioChunks.push(event.data);
      }
    };

    setAudioChunks(localAudioChunks);
  };

  const stopRecording = () => {
    if (recordingStatus !== "recording") return;

    setRecordingStatus("inactive");
    mediaRecorder.current.stop();

    mediaRecorder.current.onstop = () => {
      const blob = new Blob(audioChunks, { type: mimeType });
      setAudioBlob(blob);
      setAudioChunks([]); // Clear chunks after recording
    };
  };

  const sendAudio = async () => {
    if (!audioBlob) {
      console.error("No audio to send.");
      return;
    }

    try {
      // Convert Blob to ArrayBuffer
      const arrayBuffer = await audioBlob.arrayBuffer();

      // Decode the audio data
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const decodedAudio = await audioContext.decodeAudioData(arrayBuffer);

      // Resample to 24kHz, 1 channel, PCM16 format
      const resampledBuffer = await resampleAudio(decodedAudio, 24000, 1);
      const pcmData = convertToPCM16(resampledBuffer);

      // Encode PCM data to Base64
      const base64Audio = arrayBufferToBase64(pcmData);

      // Send audio to WebSocket
      sendAudioToWebSocket(base64Audio);
    } catch (err) {
      console.error("Error processing audio:", err);
    }
  };

  const resampleAudio = async (audioBuffer, targetSampleRate, numChannels) => {
    const offlineContext = new OfflineAudioContext(
      numChannels,
      (audioBuffer.length * targetSampleRate) / audioBuffer.sampleRate,
      targetSampleRate
    );

    const source = offlineContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineContext.destination);
    source.start();

    return await offlineContext.startRendering();
  };

  const convertToPCM16 = (audioBuffer) => {
    const channelData = audioBuffer.getChannelData(0);
    const pcmData = new Int16Array(channelData.length);

    for (let i = 0; i < channelData.length; i++) {
      let s = Math.max(-1, Math.min(1, channelData[i]));
      pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    return pcmData.buffer;
  };

  const arrayBufferToBase64 = (buffer) => {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };

  const sendAudioToWebSocket = (base64Audio) => {
    if (websocketRef.current && websocketRef.current.readyState === WebSocket.OPEN) {
      const message = {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_audio",
              audio: base64Audio,
            },
          ],
        },
      };
  
      websocketRef.current.send(JSON.stringify(message));
      console.log("Audio sent to WebSocket server.");
  
      // Send a response.create message to request the assistant's response
      const responseCreateMessage = { type: "response.create" };
      websocketRef.current.send(JSON.stringify(responseCreateMessage));
      console.log("Sent response.create to request a response from the assistant.");
    } else {
      console.error("WebSocket is not connected.");
    }
  };

  const handleServerMessage = async (message) => {
    console.log("Received message from server:", message);
    try {
      const parsedMessage = JSON.parse(message);
      if (parsedMessage.type === "error") {
        console.error("Error from server:", parsedMessage.error);
        return;
      }

      if (parsedMessage.type === "output_audio") {
        const audioBase64 = parsedMessage.audio;
        console.log("Audio received:", audioBase64);
        await playAudioFromBase64(audioBase64);
      }

      // Handle other message types if necessary
    } catch (err) {
      console.error("Error handling server message:", err);
    }
  };

  const playAudioFromBase64 = async (base64Audio) => {
    try {
      // Decode Base64 to ArrayBuffer
      const binaryString = atob(base64Audio);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // Decode audio data
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const decodedAudio = await audioContext.decodeAudioData(bytes.buffer);

      // Create a buffer source and play the audio
      const source = audioContext.createBufferSource();
      source.buffer = decodedAudio;
      source.connect(audioContext.destination);
      source.start();

      console.log("Audio playback started.");
    } catch (err) {
      console.error("Error during audio playback:", err);
    }
  };

  return (
    <div>
      <h2>Audio Recorder</h2>
      <div className="audio-controls">
        {!permission ? (
          <button onClick={getMicrophonePermission}>Get Microphone</button>
        ) : null}
        {permission && recordingStatus === "inactive" ? (
          <button onClick={startRecording}>Start Recording</button>
        ) : null}
        {recordingStatus === "recording" ? (
          <button onClick={stopRecording}>Stop Recording</button>
        ) : null}
        {audioBlob && recordingStatus === "inactive" ? (
          <>
            <button onClick={sendAudio}>Send Audio</button>
          </>
        ) : null}
      </div>
    </div>
  );
};

export default AudioRecorder;
