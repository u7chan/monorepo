interface Props {
  size?: number
  className?: string
}

export function UploadIcon({ size = 24, className = 'fill-black' }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox='0 0 24 24'
      fill='none'
      xmlns='http://www.w3.org/2000/svg'
    >
      <title>upload-icon</title>
      <path
        d='M5.625 15C5.625 14.5858 5.28921 14.25 4.875 14.25C4.46079 14.25 4.125 14.5858 4.125 15H5.625ZM4.875 16H4.125H4.875ZM19.275 15C19.275 14.5858 18.9392 14.25 18.525 14.25C18.1108 14.25 17.775 14.5858 17.775 15H19.275ZM12.2914 5.46127C12.5461 5.13467 12.4879 4.66338 12.1613 4.40862C11.8347 4.15387 11.3634 4.21212 11.1086 4.53873L12.2914 5.46127ZM7.20862 9.53873C6.95387 9.86533 7.01212 10.3366 7.33873 10.5914C7.66533 10.8461 8.13662 10.7879 8.39138 10.4613L7.20862 9.53873ZM12.2914 4.53873C12.0366 4.21212 11.5653 4.15387 11.2387 4.40862C10.9121 4.66338 10.8539 5.13467 11.1086 5.46127L12.2914 4.53873ZM15.0086 10.4613C15.2634 10.7879 15.7347 10.8461 16.0613 10.5914C16.3879 10.3366 16.4461 9.86533 16.1914 9.53873L15.0086 10.4613ZM12.45 5C12.45 4.58579 12.1142 4.25 11.7 4.25C11.2858 4.25 10.95 4.58579 10.95 5H12.45ZM10.95 16C10.95 16.4142 11.2858 16.75 11.7 16.75C12.1142 16.75 12.45 16.4142 12.45 16H10.95ZM4.125 15V16H5.625V15H4.125ZM4.125 16C4.125 18.0531 5.75257 19.75 7.8 19.75V18.25C6.61657 18.25 5.625 17.2607 5.625 16H4.125ZM7.8 19.75H15.6V18.25H7.8V19.75ZM15.6 19.75C17.6474 19.75 19.275 18.0531 19.275 16H17.775C17.775 17.2607 16.7834 18.25 15.6 18.25V19.75ZM19.275 16V15H17.775V16H19.275ZM11.1086 4.53873L7.20862 9.53873L8.39138 10.4613L12.2914 5.46127L11.1086 4.53873ZM11.1086 5.46127L15.0086 10.4613L16.1914 9.53873L12.2914 4.53873L11.1086 5.46127ZM10.95 5V16H12.45V5H10.95Z'
        className={className}
      />
    </svg>
  )
}
