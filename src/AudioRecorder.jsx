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
  const audioContextRef = useRef(null);
  const workletNodeRef = useRef(null);

  const getMicrophonePermission = async () => {
    if ("MediaRecorder" in window) {
      try {
        const mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
        setPermission(true);
        setStream(mediaStream);

        // Setup AudioContext and AudioWorklet
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        audioContextRef.current = audioContext;

        await audioContext.audioWorklet.addModule('audio-worklet-processor.js');
        const workletNode = new AudioWorkletNode(audioContext, 'pcm-player-processor');
        workletNode.connect(audioContext.destination);
        workletNodeRef.current = workletNode;

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

      // Decode the audio data at its native rate
      const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
      const decodedAudio = await tempCtx.decodeAudioData(arrayBuffer);

      // Resample to 16 kHz mono PCM16 because that's what the server expects
      const resampledBuffer = await resampleAudio(decodedAudio, 16000, 1);
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
      Math.ceil((audioBuffer.length * targetSampleRate) / audioBuffer.sampleRate),
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

      // Request a response from the assistant
      const responseCreateMessage = { type: "response.create" };
      websocketRef.current.send(JSON.stringify(responseCreateMessage));
      console.log("Sent response.create.");
    } else {
      console.error("WebSocket is not connected.");
    }
  };

  const handleServerMessage = (message) => {
    console.log("Received message from server:", message);
    try {
      const parsedMessage = JSON.parse(message);
      if (parsedMessage.type === "error") {
        console.error("Error from server:", parsedMessage.error);
        return;
      }

      if (parsedMessage.type === "output_audio") {
        const audioBase64 = parsedMessage.audio;

        // Convert base64 to Int16 PCM (16kHz)
        const int16Data = base64ToInt16(audioBase64);
        // Convert to Float32
        const float32Data = int16ToFloat32(int16Data);
        // Resample from 16kHz to audioContext.sampleRate for correct playback speed
        const resampledData = resampleFloat32(float32Data, 24000, audioContextRef.current.sampleRate);

        // Send resampled float32 data to the processor
        if (workletNodeRef.current) {
          workletNodeRef.current.port.postMessage(resampledData);
        }
      }

    } catch (err) {
      console.error("Error handling server message:", err);
    }
  };

  const base64ToInt16 = (base64) => {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Int16Array(len / 2);
    for (let i = 0; i < len; i += 2) {
      bytes[i / 2] = (binaryString.charCodeAt(i)) | (binaryString.charCodeAt(i+1) << 8);
    }
    return bytes;
  };

  const int16ToFloat32 = (int16Data) => {
    const float32Data = new Float32Array(int16Data.length);
    for (let i = 0; i < int16Data.length; i++) {
      float32Data[i] = int16Data[i] / 32768;
    }
    return float32Data;
  };

  const resampleFloat32 = (inputSamples, inputRate, outputRate) => {
    if (inputRate === outputRate) {
      return inputSamples;
    }
    const ratio = outputRate / inputRate;
    const outputLength = Math.floor(inputSamples.length * ratio);
    const output = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const index = i / ratio;
      const low = Math.floor(index);
      const high = Math.min(low + 1, inputSamples.length - 1);
      const t = index - low;
      output[i] = inputSamples[low] * (1 - t) + inputSamples[high] * t;
    }
    return output;
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
          <button onClick={sendAudio}>Send Audio</button>
        ) : null}
      </div>
    </div>
  );
};

export default AudioRecorder;
