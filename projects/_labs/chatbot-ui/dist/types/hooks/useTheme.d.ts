type Theme = 'dark' | 'light' | 'system';
export declare function useTheme(): {
    theme: Theme;
    setTheme: (theme: Theme) => void;
};
export declare function initializeTheme(): void;
export {};
