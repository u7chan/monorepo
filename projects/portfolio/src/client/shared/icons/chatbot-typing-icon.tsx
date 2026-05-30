import { type IconProps, SvgIcon } from './icon-base'

export function ChatbotTypingIcon({ size = 24, className = 'stroke-black dark:stroke-white' }: IconProps) {
  return (
    <SvgIcon size={size} viewBox='0 0 400 400' title='chatbot-typing-icon'>
      <style>{`
        .bot-root { transform-origin: center; animation: botBob 0.8s ease-in-out infinite; }
        .bot-head { transform-origin: 190px 150px; animation: botHeadSwing 0.52s ease-in-out infinite; }
        .bot-arm-left { transform-origin: 100px 191px; animation: botTapLeft 0.18s ease-in-out infinite 0.06s; }
        .bot-arm-1 { transform-origin: 219px 236px; animation: botTap1 0.14s ease-in-out infinite; }
        .bot-arm-2 { transform-origin: 219px 190px; animation: botTap2 0.14s ease-in-out infinite; }
        .bot-eye { transform-origin: center; animation: botBlink 2.1s ease-in-out infinite; }
        .spark-1 { animation: spark1 0.35s ease-in-out infinite; }
        .spark-2 { animation: spark2 0.28s ease-in-out infinite; }
        .spark-3 { animation: spark3 0.31s ease-in-out infinite; }

        @keyframes botBob {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translate(-2px, -5px) rotate(-1deg); }
        }

        @keyframes botTap1 {
          0%, 100% { transform: rotate(0deg) translateY(0px); }
          50% { transform: rotate(6deg) translate(2px, 10px); }
        }

        @keyframes botTap2 {
          0%, 100% { transform: rotate(0deg) translateY(0px); }
          50% { transform: rotate(8deg) translate(5px, 12px); }
        }

        @keyframes botTapLeft {
          0%, 100% { transform: rotate(0deg) translate(0px, 0px); }
          50% { transform: rotate(-7deg) translate(-4px, 10px); }
        }

        @keyframes botHeadSwing {
          0%, 100% { transform: rotate(0deg) translate(0px, 0px); }
          50% { transform: rotate(2.2deg) translate(1px, -1px); }
        }

        @keyframes botBlink {
          0%, 45%, 100% { transform: scaleY(1); }
          48%, 52% { transform: scaleY(0.2); }
        }

        @keyframes spark1 {
          0%, 100% { transform: translateY(0); opacity: 0; }
          50% { transform: translateY(-10px); opacity: 1; }
        }

        @keyframes spark2 {
          0%, 100% { transform: translateY(0); opacity: 0; }
          50% { transform: translateY(-10px); opacity: 1; }
        }

        @keyframes spark3 {
          0%, 100% { transform: translateY(0); opacity: 0; }
          50% { transform: translateY(-12px); opacity: 1; }
        }
      `}</style>

      <g
        fill='none'
        stroke='currentColor'
        strokeWidth='16'
        strokeLinecap='round'
        strokeLinejoin='round'
        className={`bot-root ${className}`}
      >
        <g className='bot-head'>
          <path d='M97.8357 54.6682C177.199 59.5311 213.038 52.9891 238.043 52.9891C261.298 52.9891 272.24 129.465 262.683 152.048C253.672 173.341 100.331 174.196 93.1919 165.763C84.9363 156.008 89.7095 115.275 89.7095 101.301' />
          <path d='M80.1174 119.041C75.5996 120.222 71.0489 119.99 66.4414 120.41' />
          <path d='M59.5935 109.469C59.6539 117.756 59.5918 125.915 58.9102 134.086' />
          <path d='M277.741 115.622C281.155 115.268 284.589 114.823 287.997 114.255' />
          <path d='M291.412 104.682C292.382 110.109 292.095 115.612 292.095 121.093' />
          <path d='M225.768 116.466C203.362 113.993 181.657 115.175 160.124 118.568' />
        </g>

        <path className='bot-arm-left' d='M98.3318 190.694C-10.6597 291.485 121.25 273.498 148.233 295.083' />
        <path className='bot-arm-left' d='M98.3301 190.694C99.7917 213.702 101.164 265.697 100.263 272.898' />
        <path d='M203.398 241.72C352.097 239.921 374.881 226.73 312.524 341.851' />
        <path d='M285.55 345.448C196.81 341.85 136.851 374.229 178.223 264.504' />
        <path d='M180.018 345.448C160.77 331.385 139.302 320.213 120.658 304.675' />
        <path className='bot-arm-1' d='M218.395 190.156C219.024 205.562 219.594 220.898 219.594 236.324' />
        <path className='bot-arm-2' d='M218.395 190.156C225.896 202.037 232.97 209.77 241.777 230.327' />
      </g>

      <ellipse className='bot-eye' cx='177' cy='130' rx='7' ry='5' fill='currentColor' />
      <ellipse className='bot-eye' cx='208' cy='130' rx='7' ry='5' fill='currentColor' />

      <circle className='spark-1' cx='246' cy='262' r='2.8' fill='currentColor' />
      <circle className='spark-2' cx='286' cy='258' r='2.4' fill='currentColor' />
      <circle className='spark-3' cx='310' cy='264' r='2.6' fill='currentColor' />
    </SvgIcon>
  )
}
