import { useEffect, useRef, useState } from 'react'

export function Llm() {
  const [isRecording, setIsRecording] = useState(false)
  const [audioURL, setAudioURL] = useState<string | null>(null)
  const [elapsedTime, setElapsedTime] = useState(0)
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null)
  const [isClient, setIsClient] = useState(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const audioChunksRef = useRef<Blob[]>([])

  useEffect(() => {
    setIsClient(true)
  }, [])

  const startRecording = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert(
        'マイク機能がこのブラウザではサポートされていないか、安全でない接続(HTTP)でアクセスしている可能性があります。',
      )
      console.error('MediaDevices API not supported.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaRecorderRef.current = new MediaRecorder(stream)
      audioChunksRef.current = []

      mediaRecorderRef.current.ondataavailable = (event) => {
        audioChunksRef.current.push(event.data)
      }

      mediaRecorderRef.current.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
        setAudioBlob(audioBlob)
        const audioUrl = URL.createObjectURL(audioBlob)
        setAudioURL(audioUrl)
        stream.getTracks().forEach((track) => track.stop()) // Stop the microphone access
      }

      mediaRecorderRef.current.start()
      setIsRecording(true)
      setElapsedTime(0)
      timerRef.current = setInterval(() => {
        setElapsedTime((prev) => {
          if (prev >= 59) {
            stopRecording()
            return 60
          }
          return prev + 1
        })
      }, 1000)
    } catch (err) {
      console.error('Error accessing microphone:', err)
      alert(`マイクへのアクセスでエラーが発生しました: ${err}`)
    }
  }

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
      setIsRecording(false)
      if (timerRef.current) {
        clearInterval(timerRef.current)
      }
    }
  }

  const handleToggleRecording = () => {
    if (isRecording) {
      stopRecording()
    } else {
      setAudioURL(null)
      setAudioBlob(null)
      startRecording()
    }
  }

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

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
      }
    }
  }, [])

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
