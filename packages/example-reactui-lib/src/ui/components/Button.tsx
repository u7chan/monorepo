import React from 'react'

type ButtonProps = {
  type?: React.ButtonHTMLAttributes<HTMLButtonElement>['type']
  onClick?: () => void
  children?: React.ReactNode
}

export const Button: React.FC<ButtonProps> = ({ type = 'button', onClick, children }) => {
  return (
    <button type={type} onClick={onClick}>
      {children}
    </button>
  )
}
