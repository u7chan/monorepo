import type { ReactNode } from 'react';
interface MessageAreaScrollProps {
    children?: ReactNode;
    scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
    onScroll?: () => void;
}
export declare const MessageAreaScroll: import("react").ForwardRefExoticComponent<MessageAreaScrollProps & import("react").RefAttributes<HTMLDivElement>>;
export {};
