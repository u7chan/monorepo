import React from 'react'

type ButtonProps = {
  onClick: () => void
  children: React.ReactNode
}

export const Button: React.FC<ButtonProps> = ({ onClick, children }) => {
  return <button onClick={onClick}>{children}</button>
}
