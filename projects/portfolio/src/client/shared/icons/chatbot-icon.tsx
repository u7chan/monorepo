import { ChatbotOutline } from './chatbot-outline'
import { type IconProps, SvgIcon } from './icon-base'

export function ChatbotIcon({ size = 24, label, className, ...rest }: IconProps) {
  return (
    <SvgIcon size={size} viewBox='0 0 400 400' label={label} className={className} {...rest}>
      <ChatbotOutline />
    </SvgIcon>
  )
}
