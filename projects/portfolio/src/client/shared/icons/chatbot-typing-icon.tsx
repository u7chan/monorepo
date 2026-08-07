import './chatbot-typing-icon.css'
import { CHATBOT_PATHS } from './chatbot-outline'
import { type IconProps, SvgIcon } from './icon-base'

export function ChatbotTypingIcon({ size = 24, label, className, ...rest }: IconProps) {
  return (
    <SvgIcon size={size} viewBox='0 0 400 400' label={label} className={className} {...rest}>
      <g
        fill='none'
        stroke='currentColor'
        strokeWidth='16'
        strokeLinecap='round'
        strokeLinejoin='round'
        className='bot-root'
      >
        <g className='bot-head'>
          <path d={CHATBOT_PATHS.head[0]} />
          <path d={CHATBOT_PATHS.head[1]} />
          <path d={CHATBOT_PATHS.head[2]} />
          <path d={CHATBOT_PATHS.head[3]} />
          <path d={CHATBOT_PATHS.head[4]} />
          <path d={CHATBOT_PATHS.head[5]} />
        </g>

        <path className='bot-arm-left' d={CHATBOT_PATHS.armLeft[0]} />
        <path className='bot-arm-left' d={CHATBOT_PATHS.armLeft[1]} />
        <path d={CHATBOT_PATHS.body[0]} />
        <path d={CHATBOT_PATHS.body[1]} />
        <path d={CHATBOT_PATHS.body[2]} />
        <path className='bot-arm-1' d={CHATBOT_PATHS.arm1[0]} />
        <path className='bot-arm-2' d={CHATBOT_PATHS.arm2[0]} />
      </g>

      <ellipse className='bot-eye' cx='177' cy='130' rx='7' ry='5' fill='currentColor' />
      <ellipse className='bot-eye' cx='208' cy='130' rx='7' ry='5' fill='currentColor' />

      <circle className='spark-1' cx='246' cy='262' r='2.8' fill='currentColor' />
      <circle className='spark-2' cx='286' cy='258' r='2.4' fill='currentColor' />
      <circle className='spark-3' cx='310' cy='264' r='2.6' fill='currentColor' />
    </SvgIcon>
  )
}
