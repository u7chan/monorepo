import { useRef, useImperativeHandle, forwardRef } from 'react';

export interface VideoPlayerRef {
  getCurrentTime: () => number;
  seekTo: (time: number) => void;
}

interface VideoPlayerProps {
  src: string;
}

export const VideoPlayer = forwardRef<VideoPlayerRef, VideoPlayerProps>(
  ({ src }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null);

    useImperativeHandle(ref, () => ({
      getCurrentTime: () => videoRef.current?.currentTime ?? 0,
      seekTo: (time: number) => {
        if (videoRef.current) {
          videoRef.current.currentTime = time;
        }
      },
    }));

    return (
      <video
        ref={videoRef}
        src={src}
        controls
        className="w-full h-full rounded-lg bg-black"
      />
    );
  }
);

VideoPlayer.displayName = 'VideoPlayer';
