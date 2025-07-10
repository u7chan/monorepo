import { useEffect, useState } from 'react'
import { useAudioRecorder } from '../hooks/useAudioRecorder'

export function Llm() {
  const { isRecording, audioURL, elapsedTime, audioBlob, handleToggleRecording } =
    useAudioRecorder()
  const [isClient, setIsClient] = useState(false)

  useEffect(() => {
    setIsClient(true)
  }, [])

  const handleSend = async () => {
    if (!audioBlob) return

    const formData = new FormData()
    formData.append('file', audioBlob, 'recording.webm')

    try {
      // Replace with your actual backend endpoint
      console.log('Sending audio to the backend...')
      // const response = await fetch('/api/whisper', {
      //   method: 'POST',
      //   body: formData,
      // });
      // if (!response.ok) {
      //   throw new Error('Network response was not ok');
      // }
      // const result = await response.json();
      // console.log('Success:', result);
      alert('バックエンドへの送信をシミュレートしました。コンソールログを確認してください。')
    } catch (error) {
      console.error('Error sending audio:', error)
      alert('音声の送信中にエラーが発生しました。')
    }
  }

  const formatTime = (seconds: number) => {
    const minutes = Math.floor(seconds / 60)
      .toString()
      .padStart(2, '0')
    const secs = (seconds % 60).toString().padStart(2, '0')
    return `${minutes}:${secs}`
  }

  return (
    <div className='container mx-auto max-w-2xl p-4'>
      <h1 className='mb-4 font-bold text-2xl'>Whisper Audio Recorder</h1>
      <div className='rounded-lg border bg-white p-6 dark:bg-gray-800'>
        <div className='flex flex-col items-center space-y-4'>
          <p className='text-lg'>
            {isRecording ? 'Recording...' : 'Press the button to start recording.'}
          </p>
          <button
            type='button'
            onClick={handleToggleRecording}
            disabled={!isClient}
            className={`rounded-full px-6 py-3 font-semibold text-white transition-colors duration-300 ${
              isRecording ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-500 hover:bg-blue-600'
            } ${!isClient ? 'cursor-not-allowed opacity-50' : ''}`}
          >
            {isRecording ? 'Stop Recording' : 'Start Recording'}
          </button>
          <div className='font-mono text-2xl'>{formatTime(elapsedTime)} / 01:00</div>
        </div>

        {audioURL && (
          <div className='mt-6'>
            <h2 className='mb-2 font-semibold text-xl'>Recorded Audio</h2>
            <audio controls src={audioURL} className='w-full'>
              <track kind='captions' src='' label='No captions available' />
            </audio>
            <div className='mt-4 flex justify-center'>
              <button
                type='button'
                onClick={handleSend}
                disabled={!audioBlob}
                className='rounded-lg bg-green-500 px-6 py-2 font-semibold text-white hover:bg-green-600 disabled:cursor-not-allowed disabled:bg-gray-400'
              >
                Send to Server
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
