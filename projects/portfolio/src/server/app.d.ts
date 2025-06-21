type Env = Partial<{
    NODE_ENV: string;
    SERVER_PORT: string;
    DATABASE_URL: string;
    COOKIE_SECRET: string;
    COOKIE_NAME: string;
    COOKIE_EXPIRES: string;
}>;
type HonoEnv = {
    Bindings: Env;
};
declare const app: import('hono/hono-base').HonoBase<HonoEnv, {
    "api/signin": {
        $post: {
            input: {
                json: {
                    email: string;
                    password: string;
                };
            };
            output: {};
            outputFormat: "json";
            status: import('hono/utils/http-status').ContentfulStatusCode;
        };
    };
} & {
    "/api/profile": {
        $post: {
            input: {
                form: {
                    name: string;
                    email: string;
                };
            };
            output: {
                name: string;
                email: string;
                updated_at: string;
            };
            outputFormat: "json";
            status: import('hono/utils/http-status').ContentfulStatusCode;
        };
    };
} & {
    "/api/chat": {
        $post: {
            input: {
                header: {
                    'api-key': string;
                    'base-url': string;
                    'mcp-server-urls': string;
                };
            } & {
                json: {
                    messages: ({
                        role: "system";
                        content: string;
                    } | {
                        role: "assistant";
                        content: string;
                    } | {
                        role: "user";
                        content: string | ({
                            type: "text";
                            text: string;
                        } | {
                            type: "image_url";
                            image_url: {
                                url: string;
                                detail?: "auto" | "low" | "high" | undefined;
                            };
                        })[];
                    })[];
                    model: string;
                    temperature?: number | undefined;
                    stream?: boolean | undefined;
                    max_tokens?: number | undefined;
                    stream_options?: {
                        include_usage?: boolean | undefined;
                    } | undefined;
                };
            };
            output: {};
            outputFormat: string;
            status: import('hono/utils/http-status').StatusCode;
        };
    };
} & {
    "/api/chat/completions": {
        $post: {
            input: {
                json: {
                    messages: ({
                        role: "system";
                        content: string;
                    } | {
                        role: "assistant";
                        content: string;
                    } | {
                        role: "user";
                        content: string | ({
                            type: "text";
                            text: string;
                        } | {
                            type: "image_url";
                            image_url: {
                                url: string;
                                detail?: "auto" | "low" | "high" | undefined;
                            };
                        })[];
                    })[];
                    model: string;
                    temperature?: number | undefined;
                    stream?: boolean | undefined;
                    max_tokens?: number | undefined;
                    stream_options?: {
                        include_usage?: boolean | undefined;
                    } | undefined;
                };
            };
            output: {};
            outputFormat: string;
            status: import('hono/utils/http-status').StatusCode;
        };
    };
} & {
    "/api/conversations": {
        $get: {
            input: {};
            output: {
                data: {
                    id: string;
                    title: string;
                    messages: {
                        role: string;
                        content: string;
                        reasoning_content?: string | undefined;
                    }[];
                }[];
            };
            outputFormat: "json";
            status: import('hono/utils/http-status').ContentfulStatusCode;
        };
    };
} & {
    "/api/conversations": {
        $post: {
            input: {
                json: {
                    id: string;
                    title: string;
                    messages: {
                        role: "user" | "assistant";
                        content: string;
                        reasoningContent: string;
                        metadata: {
                            temperature?: number | undefined;
                            maxTokens?: number | undefined;
                            stream?: boolean | undefined;
                            finishReason?: string | undefined;
                            completionTokens?: number | undefined;
                            promptTokens?: number | undefined;
                            totalTokens?: number | undefined;
                            reasoningTokens?: number | undefined;
                        };
                    }[];
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                json: {
                    id: string;
                    title: string;
                    messages: {
                        role: "user" | "assistant";
                        content: string;
                        reasoningContent: string;
                        metadata: {
                            temperature?: number | undefined;
                            maxTokens?: number | undefined;
                            stream?: boolean | undefined;
                            finishReason?: string | undefined;
                            completionTokens?: number | undefined;
                            promptTokens?: number | undefined;
                            totalTokens?: number | undefined;
                            reasoningTokens?: number | undefined;
                        };
                    }[];
                };
            };
            output: {
                conversationId: string;
            };
            outputFormat: "json";
            status: import('hono/utils/http-status').ContentfulStatusCode;
        };
    };
} & {
    "*": {
        $get: {
            input: {};
            output: {};
            outputFormat: string;
            status: import('hono/utils/http-status').StatusCode;
        };
    };
}, "/">;
export type AppType = typeof app;
export default app;
