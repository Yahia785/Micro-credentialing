import { useEffect, useRef } from 'react';

/** Stops every track of both streams when the component unmounts, so the camera and screen capture end. */
export function useStopStreamsOnUnmount(webcamStream: MediaStream | null, screenStream: MediaStream | null) {
  const streamsRef = useRef<Array<MediaStream | null>>([]);

  useEffect(() => {
    streamsRef.current = [webcamStream, screenStream];
  }, [webcamStream, screenStream]);

  useEffect(() => {
    return () => {
      streamsRef.current.forEach((stream) => {
        stream?.getTracks().forEach((track) => {
          if (track.readyState === 'live') track.stop();
        });
      });
    };
  }, []);
}
