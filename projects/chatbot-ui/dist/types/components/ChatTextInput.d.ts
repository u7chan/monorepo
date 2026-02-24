interface ChatTextInputProps {
    placeholder?: string;
    loading?: boolean;
    onSendMessage?: (message: string) => void;
    onSendMessageCancel?: () => void;
}
export declare function ChatTextInput({ loading, placeholder, onSendMessage, onSendMessageCancel, }: ChatTextInputProps): import("react/jsx-runtime").JSX.Element;
export {};
