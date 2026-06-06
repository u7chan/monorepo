import type { ReactNode } from 'react';
export type Message = {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
};
interface MessageAreaProps {
    messages: Message[];
    streamingText?: string;
    loading?: boolean;
    userIcon?: string | ReactNode;
    botIcon?: string | ReactNode;
    renderer?: (content: string) => ReactNode;
}
export declare function MessageArea({ messages, streamingText, loading, userIcon, botIcon, renderer, }: MessageAreaProps): import("react/jsx-runtime").JSX.Element;
export {};
