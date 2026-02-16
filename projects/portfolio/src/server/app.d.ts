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
            output: {
                readonly success: false;
                readonly error: readonly import("@standard-schema/spec").StandardSchemaV1.Issue[];
                readonly data: any;
            };
            outputFormat: "json";
            status: 400;
        } | {
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
                    stream?: boolean | undefined;
                    temperature?: number | undefined;
                    max_tokens?: number | undefined;
                    reasoning_effort?: "low" | "high" | "none" | "minimal" | "medium" | "xhigh" | undefined;
                    stream_options?: {
                        include_usage?: boolean | undefined;
                    } | undefined;
                };
            };
            output: {
                readonly success: false;
                readonly error: readonly import("@standard-schema/spec").StandardSchemaV1.Issue[];
                readonly data: any;
            };
            outputFormat: "json";
            status: 400;
        } | {
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
                    stream?: boolean | undefined;
                    temperature?: number | undefined;
                    max_tokens?: number | undefined;
                    reasoning_effort?: "low" | "high" | "none" | "minimal" | "medium" | "xhigh" | undefined;
                    stream_options?: {
                        include_usage?: boolean | undefined;
                    } | undefined;
                };
            };
            output: {};
            outputFormat: string;
            status: import('hono/utils/http-status').StatusCode;
        } | {
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
                    stream?: boolean | undefined;
                    temperature?: number | undefined;
                    max_tokens?: number | undefined;
                    reasoning_effort?: "low" | "high" | "none" | "minimal" | "medium" | "xhigh" | undefined;
                    stream_options?: {
                        include_usage?: boolean | undefined;
                    } | undefined;
                };
            };
            output: {
                message: string;
            };
            outputFormat: "json";
            status: 400;
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
                    stream?: boolean | undefined;
                    temperature?: number | undefined;
                    max_tokens?: number | undefined;
                    stream_options?: {
                        include_usage?: boolean | undefined;
                    } | undefined;
                };
            };
            output: {
                readonly success: false;
                readonly error: readonly import("@standard-schema/spec").StandardSchemaV1.Issue[];
                readonly data: any;
            };
            outputFormat: "json";
            status: 400;
        } | {
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
                    stream?: boolean | undefined;
                    temperature?: number | undefined;
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
                    messages: ({
                        role: "user";
                        content: string | ({
                            type: "image_url";
                            image_url: {
                                url: string;
                            };
                        } | {
                            type: "text";
                            text: string;
                        })[];
                        reasoningContent: string;
                        metadata: {
                            model: string;
                            stream?: boolean | undefined;
                            temperature?: number | undefined;
                            maxTokens?: number | undefined;
                        };
                        id?: string | undefined;
                    } | {
                        role: "assistant";
                        content: string;
                        metadata: {
                            model: string;
                            usage: {
                                completionTokens?: number | undefined;
                                promptTokens?: number | undefined;
                                totalTokens?: number | undefined;
                                reasoningTokens?: number | undefined;
                            };
                            finishReason?: string | undefined;
                        };
                        id?: string | undefined;
                        reasoningContent?: string | undefined;
                    } | {
                        role: "system";
                        content: string;
                        reasoningContent: string;
                        id?: string | undefined;
                        metadata?: {} | undefined;
                    })[];
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
                    messages: ({
                        role: "user";
                        content: string | ({
                            type: "image_url";
                            image_url: {
                                url: string;
                            };
                        } | {
                            type: "text";
                            text: string;
                        })[];
                        metadata: {
                            model: string;
                            stream?: boolean | undefined;
                            temperature?: number | undefined;
                            maxTokens?: number | undefined;
                        };
                        id?: string | undefined;
                        reasoningContent?: string | undefined;
                    } | {
                        role: "assistant";
                        content: string;
                        metadata: {
                            model: string;
                            usage: {
                                completionTokens?: number | undefined;
                                promptTokens?: number | undefined;
                                totalTokens?: number | undefined;
                                reasoningTokens?: number | undefined;
                            };
                            finishReason?: string | undefined;
                        };
                        id?: string | undefined;
                        reasoningContent?: string | undefined;
                    } | {
                        role: "system";
                        content: string;
                        id?: string | undefined;
                        reasoningContent?: string | undefined;
                        metadata?: Record<string, never> | undefined;
                    })[];
                };
            };
            output: {
                readonly success: false;
                readonly error: readonly import("@standard-schema/spec").StandardSchemaV1.Issue[];
                readonly data: any;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                json: {
                    id: string;
                    title: string;
                    messages: ({
                        role: "user";
                        content: string | ({
                            type: "image_url";
                            image_url: {
                                url: string;
                            };
                        } | {
                            type: "text";
                            text: string;
                        })[];
                        metadata: {
                            model: string;
                            stream?: boolean | undefined;
                            temperature?: number | undefined;
                            maxTokens?: number | undefined;
                        };
                        id?: string | undefined;
                        reasoningContent?: string | undefined;
                    } | {
                        role: "assistant";
                        content: string;
                        metadata: {
                            model: string;
                            usage: {
                                completionTokens?: number | undefined;
                                promptTokens?: number | undefined;
                                totalTokens?: number | undefined;
                                reasoningTokens?: number | undefined;
                            };
                            finishReason?: string | undefined;
                        };
                        id?: string | undefined;
                        reasoningContent?: string | undefined;
                    } | {
                        role: "system";
                        content: string;
                        id?: string | undefined;
                        reasoningContent?: string | undefined;
                        metadata?: Record<string, never> | undefined;
                    })[];
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
                    messages: ({
                        role: "user";
                        content: string | ({
                            type: "image_url";
                            image_url: {
                                url: string;
                            };
                        } | {
                            type: "text";
                            text: string;
                        })[];
                        metadata: {
                            model: string;
                            stream?: boolean | undefined;
                            temperature?: number | undefined;
                            maxTokens?: number | undefined;
                        };
                        id?: string | undefined;
                        reasoningContent?: string | undefined;
                    } | {
                        role: "assistant";
                        content: string;
                        metadata: {
                            model: string;
                            usage: {
                                completionTokens?: number | undefined;
                                promptTokens?: number | undefined;
                                totalTokens?: number | undefined;
                                reasoningTokens?: number | undefined;
                            };
                            finishReason?: string | undefined;
                        };
                        id?: string | undefined;
                        reasoningContent?: string | undefined;
                    } | {
                        role: "system";
                        content: string;
                        id?: string | undefined;
                        reasoningContent?: string | undefined;
                        metadata?: Record<string, never> | undefined;
                    })[];
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
    "/api/conversations": {
        $delete: {
            input: {
                query: {
                    ids: string | string[];
                };
            };
            output: {
                readonly success: false;
                readonly error: readonly import("@standard-schema/spec").StandardSchemaV1.Issue[];
                readonly data: Record<string, string | string[]>;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                query: {
                    ids: string | string[];
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                query: {
                    ids: string | string[];
                };
            };
            output: {
                success: boolean;
                deletedIds: string[];
                failedIds: string[];
            };
            outputFormat: "json";
            status: import('hono/utils/http-status').ContentfulStatusCode;
        };
    };
} & {
    "/api/conversations/messages": {
        $delete: {
            input: {
                query: {
                    ids: string | string[];
                };
            };
            output: {
                readonly success: false;
                readonly error: readonly import("@standard-schema/spec").StandardSchemaV1.Issue[];
                readonly data: Record<string, string | string[]>;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                query: {
                    ids: string | string[];
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 401;
        } | {
            input: {
                query: {
                    ids: string | string[];
                };
            };
            output: {
                success: boolean;
                deletedMessageIds: string[];
                failedMessageIds: string[];
                deletedConversationIds: string[];
            };
            outputFormat: "json";
            status: import('hono/utils/http-status').ContentfulStatusCode;
        };
    };
} & {
    "/api/fetch-models": {
        $get: {
            input: {
                header: {
                    'api-key': string;
                    'base-url': string;
                };
            };
            output: {
                message: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                header: {
                    'api-key': string;
                    'base-url': string;
                };
            };
            output: string[];
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
}, "/", "*">;
export type AppType = typeof app;
export default app;
