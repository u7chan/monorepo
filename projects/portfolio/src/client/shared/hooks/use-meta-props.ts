import { useMemo } from 'react'
import { readMetaProps, type MetaProps } from '#/client/shared/lib/meta-props'

export function useMetaProps(): MetaProps {
  return useMemo(readMetaProps, [])
}
