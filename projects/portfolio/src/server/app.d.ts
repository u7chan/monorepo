import { HonoEnv } from './routes/shared';
declare const app: import('hono/hono-base').HonoBase<HonoEnv, import('hono/types').BlankSchema, "/", "*">;
declare const routes: import('hono/hono-base').HonoBase<HonoEnv, import('hono/types').BlankSchema | import('hono/types').MergeSchemaPath<{
    "/api/signin": {
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
    "/api/signout": {
        $post: {
            input: {};
            output: {};
            outputFormat: "json";
            status: import('hono/utils/http-status').ContentfulStatusCode;
        };
    };
}, "/"> | import('hono/types').MergeSchemaPath<{
    "/api/image/generations": {
        $post: {
            input: {
                header: {
                    'api-key': string;
                    'base-url': string;
                };
            } & {
                json: {
                    prompt: string;
                    conversationId: string;
                    assistantMessageId: string;
                };
            };
            output: {
                code: "VALIDATION_ERROR" | "AUTHENTICATION_FAILED" | "MODEL_ACCESS_DENIED" | "INSUFFICIENT_CREDIT" | "RATE_LIMITED" | "INVALID_REQUEST" | "UPSTREAM_UNAVAILABLE" | "UNKNOWN_UPSTREAM_ERROR" | "IMAGE_STORAGE_NOT_CONFIGURED" | "IMAGE_STORAGE_FAILED" | "IMAGE_MODEL_ENDPOINT_INCOMPATIBLE" | "IMAGE_REQUEST_INVALID" | "IMAGE_PROVIDER_REJECTED";
                message: string;
                retryable: boolean;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                header: {
                    'api-key': string;
                    'base-url': string;
                };
            } & {
                json: {
                    prompt: string;
                    conversationId: string;
                    assistantMessageId: string;
                };
            };
            output: {
                code: "VALIDATION_ERROR" | "AUTHENTICATION_FAILED" | "MODEL_ACCESS_DENIED" | "INSUFFICIENT_CREDIT" | "RATE_LIMITED" | "INVALID_REQUEST" | "UPSTREAM_UNAVAILABLE" | "UNKNOWN_UPSTREAM_ERROR" | "IMAGE_STORAGE_NOT_CONFIGURED" | "IMAGE_STORAGE_FAILED" | "IMAGE_MODEL_ENDPOINT_INCOMPATIBLE" | "IMAGE_REQUEST_INVALID" | "IMAGE_PROVIDER_REJECTED";
                message: string;
                retryable: boolean;
            };
            outputFormat: "json";
            status: 503;
        } | {
            input: {
                header: {
                    'api-key': string;
                    'base-url': string;
                };
            } & {
                json: {
                    prompt: string;
                    conversationId: string;
                    assistantMessageId: string;
                };
            };
            output: {
                code: "VALIDATION_ERROR" | "AUTHENTICATION_FAILED" | "MODEL_ACCESS_DENIED" | "INSUFFICIENT_CREDIT" | "RATE_LIMITED" | "INVALID_REQUEST" | "UPSTREAM_UNAVAILABLE" | "UNKNOWN_UPSTREAM_ERROR" | "IMAGE_STORAGE_NOT_CONFIGURED" | "IMAGE_STORAGE_FAILED" | "IMAGE_MODEL_ENDPOINT_INCOMPATIBLE" | "IMAGE_REQUEST_INVALID" | "IMAGE_PROVIDER_REJECTED";
                message: string;
                retryable: boolean;
            };
            outputFormat: "json";
            status: 502;
        } | {
            input: {
                header: {
                    'api-key': string;
                    'base-url': string;
                };
            } & {
                json: {
                    prompt: string;
                    conversationId: string;
                    assistantMessageId: string;
                };
            };
            output: {
                id: string;
                created: number;
                model: string;
                image: {
                    fileName: string;
                    publicPath: string;
                    contentType: string;
                    createdAt: string;
                    previewUrl?: string | undefined;
                };
                usage: {
                    inputTokens?: number | undefined;
                    outputTokens?: number | undefined;
                    totalTokens?: number | undefined;
                };
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
                };
            } & {
                json: {
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
                    } | {
                        role: "assistant";
                        content: string;
                    } | {
                        role: "system";
                        content: string;
                    })[];
                    model: string;
                    apiMode?: "chat_completions" | "responses" | undefined;
                    temperature?: number | undefined;
                    maxTokens?: number | undefined;
                    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
                };
            };
            output: {
                code: "VALIDATION_ERROR" | "AUTHENTICATION_FAILED" | "MODEL_ACCESS_DENIED" | "INSUFFICIENT_CREDIT" | "RATE_LIMITED" | "INVALID_REQUEST" | "UPSTREAM_UNAVAILABLE" | "UNKNOWN_UPSTREAM_ERROR" | "IMAGE_STORAGE_NOT_CONFIGURED" | "IMAGE_STORAGE_FAILED" | "IMAGE_MODEL_ENDPOINT_INCOMPATIBLE" | "IMAGE_REQUEST_INVALID" | "IMAGE_PROVIDER_REJECTED";
                message: string;
                retryable: boolean;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                header: {
                    'api-key': string;
                    'base-url': string;
                };
            } & {
                json: {
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
                    } | {
                        role: "assistant";
                        content: string;
                    } | {
                        role: "system";
                        content: string;
                    })[];
                    model: string;
                    apiMode?: "chat_completions" | "responses" | undefined;
                    temperature?: number | undefined;
                    maxTokens?: number | undefined;
                    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
                };
            };
            output: {
                code: "VALIDATION_ERROR" | "AUTHENTICATION_FAILED" | "MODEL_ACCESS_DENIED" | "INSUFFICIENT_CREDIT" | "RATE_LIMITED" | "INVALID_REQUEST" | "UPSTREAM_UNAVAILABLE" | "UNKNOWN_UPSTREAM_ERROR" | "IMAGE_STORAGE_NOT_CONFIGURED" | "IMAGE_STORAGE_FAILED" | "IMAGE_MODEL_ENDPOINT_INCOMPATIBLE" | "IMAGE_REQUEST_INVALID" | "IMAGE_PROVIDER_REJECTED";
                message: string;
                retryable: boolean;
            };
            outputFormat: "json";
            status: 502;
        } | {
            input: {
                header: {
                    'api-key': string;
                    'base-url': string;
                };
            } & {
                json: {
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
                    } | {
                        role: "assistant";
                        content: string;
                    } | {
                        role: "system";
                        content: string;
                    })[];
                    model: string;
                    apiMode?: "chat_completions" | "responses" | undefined;
                    temperature?: number | undefined;
                    maxTokens?: number | undefined;
                    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
                };
            };
            output: {
                id: string;
                created: number;
                model: string;
                finishReason: string;
                message: {
                    content: string;
                    reasoningContent: string;
                };
                usage: {
                    promptTokens: number;
                    completionTokens: number;
                    totalTokens: number;
                    reasoningTokens?: number | undefined;
                } | null;
            };
            outputFormat: "json";
            status: import('hono/utils/http-status').ContentfulStatusCode;
        };
    };
} & {
    "/api/chat/stream": {
        $post: {
            input: {
                header: {
                    'api-key': string;
                    'base-url': string;
                };
            } & {
                json: {
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
                    } | {
                        role: "assistant";
                        content: string;
                    } | {
                        role: "system";
                        content: string;
                    })[];
                    model: string;
                    apiMode?: "chat_completions" | "responses" | undefined;
                    temperature?: number | undefined;
                    maxTokens?: number | undefined;
                    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
                };
            };
            output: {
                code: "VALIDATION_ERROR" | "AUTHENTICATION_FAILED" | "MODEL_ACCESS_DENIED" | "INSUFFICIENT_CREDIT" | "RATE_LIMITED" | "INVALID_REQUEST" | "UPSTREAM_UNAVAILABLE" | "UNKNOWN_UPSTREAM_ERROR" | "IMAGE_STORAGE_NOT_CONFIGURED" | "IMAGE_STORAGE_FAILED" | "IMAGE_MODEL_ENDPOINT_INCOMPATIBLE" | "IMAGE_REQUEST_INVALID" | "IMAGE_PROVIDER_REJECTED";
                message: string;
                retryable: boolean;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                header: {
                    'api-key': string;
                    'base-url': string;
                };
            } & {
                json: {
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
                    } | {
                        role: "assistant";
                        content: string;
                    } | {
                        role: "system";
                        content: string;
                    })[];
                    model: string;
                    apiMode?: "chat_completions" | "responses" | undefined;
                    temperature?: number | undefined;
                    maxTokens?: number | undefined;
                    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
                };
            };
            output: {};
            outputFormat: string;
            status: import('hono/utils/http-status').StatusCode;
        };
    };
} & {
    "/api/chat/sessions": {
        $post: {
            input: {
                header: {
                    'api-key': string;
                    'base-url': string;
                };
            } & {
                json: {
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
                    } | {
                        role: "assistant";
                        content: string;
                    } | {
                        role: "system";
                        content: string;
                    })[];
                    model: string;
                    conversation: {
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
                                apiMode?: "chat_completions" | "responses" | undefined;
                                stream?: boolean | undefined;
                                temperature?: number | undefined;
                                maxTokens?: number | undefined;
                                reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
                                sendImagesOnlyOnce?: boolean | undefined;
                                imageGenerationMode?: boolean | undefined;
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
                                apiMode?: "chat_completions" | "responses" | undefined;
                                finishReason?: string | undefined;
                                responseTimeMs?: number | undefined;
                                generatedFiles?: {
                                    blockIndex: number;
                                    language: string;
                                    fileName: string;
                                    publicPath: string;
                                    previewUrl: string;
                                    contentType: string;
                                    createdAt: string;
                                }[] | undefined;
                                generatedImages?: {
                                    fileName: string;
                                    publicPath: string;
                                    contentType: string;
                                    createdAt: string;
                                    previewUrl?: string | undefined;
                                }[] | undefined;
                                imageContext?: {
                                    policy: "send_once" | "full_history";
                                    sent: number;
                                    historyOnly: number;
                                } | undefined;
                                apiContextMessages?: ({
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
                                } | {
                                    role: "assistant";
                                    content: string;
                                } | {
                                    role: "system";
                                    content: string;
                                })[] | undefined;
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
                        updatedAt?: unknown;
                    };
                    assistantMessageId: string;
                    apiMode?: "chat_completions" | "responses" | undefined;
                    temperature?: number | undefined;
                    maxTokens?: number | undefined;
                    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
                };
            };
            output: {
                code: "VALIDATION_ERROR" | "AUTHENTICATION_FAILED" | "MODEL_ACCESS_DENIED" | "INSUFFICIENT_CREDIT" | "RATE_LIMITED" | "INVALID_REQUEST" | "UPSTREAM_UNAVAILABLE" | "UNKNOWN_UPSTREAM_ERROR" | "IMAGE_STORAGE_NOT_CONFIGURED" | "IMAGE_STORAGE_FAILED" | "IMAGE_MODEL_ENDPOINT_INCOMPATIBLE" | "IMAGE_REQUEST_INVALID" | "IMAGE_PROVIDER_REJECTED";
                message: string;
                retryable: boolean;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                header: {
                    'api-key': string;
                    'base-url': string;
                };
            } & {
                json: {
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
                    } | {
                        role: "assistant";
                        content: string;
                    } | {
                        role: "system";
                        content: string;
                    })[];
                    model: string;
                    conversation: {
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
                                apiMode?: "chat_completions" | "responses" | undefined;
                                stream?: boolean | undefined;
                                temperature?: number | undefined;
                                maxTokens?: number | undefined;
                                reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
                                sendImagesOnlyOnce?: boolean | undefined;
                                imageGenerationMode?: boolean | undefined;
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
                                apiMode?: "chat_completions" | "responses" | undefined;
                                finishReason?: string | undefined;
                                responseTimeMs?: number | undefined;
                                generatedFiles?: {
                                    blockIndex: number;
                                    language: string;
                                    fileName: string;
                                    publicPath: string;
                                    previewUrl: string;
                                    contentType: string;
                                    createdAt: string;
                                }[] | undefined;
                                generatedImages?: {
                                    fileName: string;
                                    publicPath: string;
                                    contentType: string;
                                    createdAt: string;
                                    previewUrl?: string | undefined;
                                }[] | undefined;
                                imageContext?: {
                                    policy: "send_once" | "full_history";
                                    sent: number;
                                    historyOnly: number;
                                } | undefined;
                                apiContextMessages?: ({
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
                                } | {
                                    role: "assistant";
                                    content: string;
                                } | {
                                    role: "system";
                                    content: string;
                                })[] | undefined;
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
                        updatedAt?: unknown;
                    };
                    assistantMessageId: string;
                    apiMode?: "chat_completions" | "responses" | undefined;
                    temperature?: number | undefined;
                    maxTokens?: number | undefined;
                    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
                };
            };
            output: {
                sessionId: string;
                status: "error" | "running" | "completed" | "cancelled";
            };
            outputFormat: "json";
            status: import('hono/utils/http-status').ContentfulStatusCode;
        };
    };
} & {
    "/api/chat/sessions/:sessionId": {
        $get: {
            input: {
                param: {
                    sessionId: string;
                };
            };
            output: {
                code: "VALIDATION_ERROR" | "AUTHENTICATION_FAILED" | "MODEL_ACCESS_DENIED" | "INSUFFICIENT_CREDIT" | "RATE_LIMITED" | "INVALID_REQUEST" | "UPSTREAM_UNAVAILABLE" | "UNKNOWN_UPSTREAM_ERROR" | "IMAGE_STORAGE_NOT_CONFIGURED" | "IMAGE_STORAGE_FAILED" | "IMAGE_MODEL_ENDPOINT_INCOMPATIBLE" | "IMAGE_REQUEST_INVALID" | "IMAGE_PROVIDER_REJECTED";
                message: string;
                retryable: boolean;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    sessionId: string;
                };
            };
            output: {
                session: {
                    id: string;
                    status: "error" | "running" | "completed" | "cancelled";
                    conversation: {
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
                                apiMode?: "chat_completions" | "responses" | undefined;
                                stream?: boolean | undefined;
                                temperature?: number | undefined;
                                maxTokens?: number | undefined;
                                reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
                                sendImagesOnlyOnce?: boolean | undefined;
                                imageGenerationMode?: boolean | undefined;
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
                                apiMode?: "chat_completions" | "responses" | undefined;
                                finishReason?: string | undefined;
                                responseTimeMs?: number | undefined;
                                generatedFiles?: {
                                    blockIndex: number;
                                    language: string;
                                    fileName: string;
                                    publicPath: string;
                                    previewUrl: string;
                                    contentType: string;
                                    createdAt: string;
                                }[] | undefined;
                                generatedImages?: {
                                    fileName: string;
                                    publicPath: string;
                                    contentType: string;
                                    createdAt: string;
                                    previewUrl?: string | undefined;
                                }[] | undefined;
                                imageContext?: {
                                    policy: "send_once" | "full_history";
                                    sent: number;
                                    historyOnly: number;
                                } | undefined;
                                apiContextMessages?: ({
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
                                } | {
                                    role: "assistant";
                                    content: string;
                                } | {
                                    role: "system";
                                    content: string;
                                })[] | undefined;
                            };
                            id?: string | undefined;
                            reasoningContent?: string | undefined;
                        } | {
                            role: "system";
                            content: string;
                            id?: string | undefined;
                            reasoningContent?: string | undefined;
                            metadata?: {} | undefined;
                        })[];
                        updatedAt?: string | undefined;
                    };
                    assistantMessageId: string;
                    apiMode: "chat_completions" | "responses";
                    model: string;
                    email: string | null;
                    createdAt: string;
                    updatedAt: string;
                    completedAt: string | null;
                    error: {
                        code: "VALIDATION_ERROR" | "AUTHENTICATION_FAILED" | "MODEL_ACCESS_DENIED" | "INSUFFICIENT_CREDIT" | "RATE_LIMITED" | "INVALID_REQUEST" | "UPSTREAM_UNAVAILABLE" | "UNKNOWN_UPSTREAM_ERROR" | "IMAGE_STORAGE_NOT_CONFIGURED" | "IMAGE_STORAGE_FAILED" | "IMAGE_MODEL_ENDPOINT_INCOMPATIBLE" | "IMAGE_REQUEST_INVALID" | "IMAGE_PROVIDER_REJECTED";
                        message: string;
                        retryable: boolean;
                    } | null;
                };
            };
            outputFormat: "json";
            status: import('hono/utils/http-status').ContentfulStatusCode;
        };
    };
} & {
    "/api/chat/sessions/:sessionId/events": {
        $get: {
            input: {
                param: {
                    sessionId: string;
                };
            };
            output: {};
            outputFormat: string;
            status: import('hono/utils/http-status').StatusCode;
        };
    };
} & {
    "/api/chat/sessions/:sessionId/cancel": {
        $post: {
            input: {
                param: {
                    sessionId: string;
                };
            };
            output: {
                code: "VALIDATION_ERROR" | "AUTHENTICATION_FAILED" | "MODEL_ACCESS_DENIED" | "INSUFFICIENT_CREDIT" | "RATE_LIMITED" | "INVALID_REQUEST" | "UPSTREAM_UNAVAILABLE" | "UNKNOWN_UPSTREAM_ERROR" | "IMAGE_STORAGE_NOT_CONFIGURED" | "IMAGE_STORAGE_FAILED" | "IMAGE_MODEL_ENDPOINT_INCOMPATIBLE" | "IMAGE_REQUEST_INVALID" | "IMAGE_PROVIDER_REJECTED";
                message: string;
                retryable: boolean;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                param: {
                    sessionId: string;
                };
            };
            output: {
                status: "error" | "running" | "completed" | "cancelled";
            };
            outputFormat: "json";
            status: import('hono/utils/http-status').ContentfulStatusCode;
        };
    };
} & {
    "/api/chat/completions": {
        $post: {
            input: {
                json: {
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
                    } | {
                        role: "assistant";
                        content: string;
                    } | {
                        role: "system";
                        content: string;
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
                    } | {
                        role: "assistant";
                        content: string;
                    } | {
                        role: "system";
                        content: string;
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
}, "/"> | import('hono/types').MergeSchemaPath<{
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
                        metadata: {
                            model: string;
                            apiMode?: "chat_completions" | "responses" | undefined;
                            stream?: boolean | undefined;
                            temperature?: number | undefined;
                            maxTokens?: number | undefined;
                            reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
                            sendImagesOnlyOnce?: boolean | undefined;
                            imageGenerationMode?: boolean | undefined;
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
                            apiMode?: "chat_completions" | "responses" | undefined;
                            finishReason?: string | undefined;
                            responseTimeMs?: number | undefined;
                            generatedFiles?: {
                                blockIndex: number;
                                language: string;
                                fileName: string;
                                publicPath: string;
                                previewUrl: string;
                                contentType: string;
                                createdAt: string;
                            }[] | undefined;
                            generatedImages?: {
                                fileName: string;
                                publicPath: string;
                                contentType: string;
                                createdAt: string;
                                previewUrl?: string | undefined;
                            }[] | undefined;
                            imageContext?: {
                                policy: "send_once" | "full_history";
                                sent: number;
                                historyOnly: number;
                            } | undefined;
                            apiContextMessages?: ({
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
                            } | {
                                role: "assistant";
                                content: string;
                            } | {
                                role: "system";
                                content: string;
                            })[] | undefined;
                        };
                        id?: string | undefined;
                        reasoningContent?: string | undefined;
                    } | {
                        role: "system";
                        content: string;
                        id?: string | undefined;
                        reasoningContent?: string | undefined;
                        metadata?: {} | undefined;
                    })[];
                    updatedAt?: string | undefined;
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
                            apiMode?: "chat_completions" | "responses" | undefined;
                            stream?: boolean | undefined;
                            temperature?: number | undefined;
                            maxTokens?: number | undefined;
                            reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
                            sendImagesOnlyOnce?: boolean | undefined;
                            imageGenerationMode?: boolean | undefined;
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
                            apiMode?: "chat_completions" | "responses" | undefined;
                            finishReason?: string | undefined;
                            responseTimeMs?: number | undefined;
                            generatedFiles?: {
                                blockIndex: number;
                                language: string;
                                fileName: string;
                                publicPath: string;
                                previewUrl: string;
                                contentType: string;
                                createdAt: string;
                            }[] | undefined;
                            generatedImages?: {
                                fileName: string;
                                publicPath: string;
                                contentType: string;
                                createdAt: string;
                                previewUrl?: string | undefined;
                            }[] | undefined;
                            imageContext?: {
                                policy: "send_once" | "full_history";
                                sent: number;
                                historyOnly: number;
                            } | undefined;
                            apiContextMessages?: ({
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
                            } | {
                                role: "assistant";
                                content: string;
                            } | {
                                role: "system";
                                content: string;
                            })[] | undefined;
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
                    updatedAt?: unknown;
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
                            apiMode?: "chat_completions" | "responses" | undefined;
                            stream?: boolean | undefined;
                            temperature?: number | undefined;
                            maxTokens?: number | undefined;
                            reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
                            sendImagesOnlyOnce?: boolean | undefined;
                            imageGenerationMode?: boolean | undefined;
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
                            apiMode?: "chat_completions" | "responses" | undefined;
                            finishReason?: string | undefined;
                            responseTimeMs?: number | undefined;
                            generatedFiles?: {
                                blockIndex: number;
                                language: string;
                                fileName: string;
                                publicPath: string;
                                previewUrl: string;
                                contentType: string;
                                createdAt: string;
                            }[] | undefined;
                            generatedImages?: {
                                fileName: string;
                                publicPath: string;
                                contentType: string;
                                createdAt: string;
                                previewUrl?: string | undefined;
                            }[] | undefined;
                            imageContext?: {
                                policy: "send_once" | "full_history";
                                sent: number;
                                historyOnly: number;
                            } | undefined;
                            apiContextMessages?: ({
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
                            } | {
                                role: "assistant";
                                content: string;
                            } | {
                                role: "system";
                                content: string;
                            })[] | undefined;
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
                    updatedAt?: unknown;
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
    "/api/conversations/messages/metadata": {
        $patch: {
            input: {
                json: {
                    conversationId: string;
                    messageId: string;
                    metadata: {
                        model?: string | undefined;
                        apiMode?: "chat_completions" | "responses" | undefined;
                        finishReason?: string | undefined;
                        responseTimeMs?: number | undefined;
                        usage?: {
                            completionTokens?: number | undefined;
                            promptTokens?: number | undefined;
                            totalTokens?: number | undefined;
                            reasoningTokens?: number | undefined;
                        } | undefined;
                        generatedFiles?: {
                            blockIndex: number;
                            language: string;
                            fileName: string;
                            publicPath: string;
                            previewUrl: string;
                            contentType: string;
                            createdAt: string;
                        }[] | undefined;
                        generatedImages?: {
                            fileName: string;
                            publicPath: string;
                            contentType: string;
                            createdAt: string;
                            previewUrl?: string | undefined;
                        }[] | undefined;
                    };
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
                    conversationId: string;
                    messageId: string;
                    metadata: {
                        model?: string | undefined;
                        apiMode?: "chat_completions" | "responses" | undefined;
                        finishReason?: string | undefined;
                        responseTimeMs?: number | undefined;
                        usage?: {
                            completionTokens?: number | undefined;
                            promptTokens?: number | undefined;
                            totalTokens?: number | undefined;
                            reasoningTokens?: number | undefined;
                        } | undefined;
                        generatedFiles?: {
                            blockIndex: number;
                            language: string;
                            fileName: string;
                            publicPath: string;
                            previewUrl: string;
                            contentType: string;
                            createdAt: string;
                        }[] | undefined;
                        generatedImages?: {
                            fileName: string;
                            publicPath: string;
                            contentType: string;
                            createdAt: string;
                            previewUrl?: string | undefined;
                        }[] | undefined;
                    };
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                json: {
                    conversationId: string;
                    messageId: string;
                    metadata: {
                        model?: string | undefined;
                        apiMode?: "chat_completions" | "responses" | undefined;
                        finishReason?: string | undefined;
                        responseTimeMs?: number | undefined;
                        usage?: {
                            completionTokens?: number | undefined;
                            promptTokens?: number | undefined;
                            totalTokens?: number | undefined;
                            reasoningTokens?: number | undefined;
                        } | undefined;
                        generatedFiles?: {
                            blockIndex: number;
                            language: string;
                            fileName: string;
                            publicPath: string;
                            previewUrl: string;
                            contentType: string;
                            createdAt: string;
                        }[] | undefined;
                        generatedImages?: {
                            fileName: string;
                            publicPath: string;
                            contentType: string;
                            createdAt: string;
                            previewUrl?: string | undefined;
                        }[] | undefined;
                    };
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 403;
        } | {
            input: {
                json: {
                    conversationId: string;
                    messageId: string;
                    metadata: {
                        model?: string | undefined;
                        apiMode?: "chat_completions" | "responses" | undefined;
                        finishReason?: string | undefined;
                        responseTimeMs?: number | undefined;
                        usage?: {
                            completionTokens?: number | undefined;
                            promptTokens?: number | undefined;
                            totalTokens?: number | undefined;
                            reasoningTokens?: number | undefined;
                        } | undefined;
                        generatedFiles?: {
                            blockIndex: number;
                            language: string;
                            fileName: string;
                            publicPath: string;
                            previewUrl: string;
                            contentType: string;
                            createdAt: string;
                        }[] | undefined;
                        generatedImages?: {
                            fileName: string;
                            publicPath: string;
                            contentType: string;
                            createdAt: string;
                            previewUrl?: string | undefined;
                        }[] | undefined;
                    };
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                json: {
                    conversationId: string;
                    messageId: string;
                    metadata: {
                        model?: string | undefined;
                        apiMode?: "chat_completions" | "responses" | undefined;
                        finishReason?: string | undefined;
                        responseTimeMs?: number | undefined;
                        usage?: {
                            completionTokens?: number | undefined;
                            promptTokens?: number | undefined;
                            totalTokens?: number | undefined;
                            reasoningTokens?: number | undefined;
                        } | undefined;
                        generatedFiles?: {
                            blockIndex: number;
                            language: string;
                            fileName: string;
                            publicPath: string;
                            previewUrl: string;
                            contentType: string;
                            createdAt: string;
                        }[] | undefined;
                        generatedImages?: {
                            fileName: string;
                            publicPath: string;
                            contentType: string;
                            createdAt: string;
                            previewUrl?: string | undefined;
                        }[] | undefined;
                    };
                };
            };
            output: {
                metadata: {
                    model: string;
                    usage: {
                        completionTokens?: number | undefined;
                        promptTokens?: number | undefined;
                        totalTokens?: number | undefined;
                        reasoningTokens?: number | undefined;
                    };
                    apiMode?: "chat_completions" | "responses" | undefined;
                    finishReason?: string | undefined;
                    responseTimeMs?: number | undefined;
                    generatedFiles?: {
                        blockIndex: number;
                        language: string;
                        fileName: string;
                        publicPath: string;
                        previewUrl: string;
                        contentType: string;
                        createdAt: string;
                    }[] | undefined;
                    generatedImages?: {
                        fileName: string;
                        publicPath: string;
                        contentType: string;
                        createdAt: string;
                        previewUrl?: string | undefined;
                    }[] | undefined;
                    imageContext?: {
                        policy: "send_once" | "full_history";
                        sent: number;
                        historyOnly: number;
                    } | undefined;
                    apiContextMessages?: ({
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
                    } | {
                        role: "assistant";
                        content: string;
                    } | {
                        role: "system";
                        content: string;
                    })[] | undefined;
                };
            };
            outputFormat: "json";
            status: import('hono/utils/http-status').ContentfulStatusCode;
        };
    };
} & {
    "/api/conversations/messages/generated-files": {
        $post: {
            input: {
                json: {
                    conversationId: string;
                    messageId: string;
                    blockIndex: number;
                    language: string;
                    content: string;
                    force?: boolean | undefined;
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
                    conversationId: string;
                    messageId: string;
                    blockIndex: number;
                    language: string;
                    content: string;
                    force?: boolean | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 404;
        } | {
            input: {
                json: {
                    conversationId: string;
                    messageId: string;
                    blockIndex: number;
                    language: string;
                    content: string;
                    force?: boolean | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 403;
        } | {
            input: {
                json: {
                    conversationId: string;
                    messageId: string;
                    blockIndex: number;
                    language: string;
                    content: string;
                    force?: boolean | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 400;
        } | {
            input: {
                json: {
                    conversationId: string;
                    messageId: string;
                    blockIndex: number;
                    language: string;
                    content: string;
                    force?: boolean | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 503;
        } | {
            input: {
                json: {
                    conversationId: string;
                    messageId: string;
                    blockIndex: number;
                    language: string;
                    content: string;
                    force?: boolean | undefined;
                };
            };
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 502;
        } | {
            input: {
                json: {
                    conversationId: string;
                    messageId: string;
                    blockIndex: number;
                    language: string;
                    content: string;
                    force?: boolean | undefined;
                };
            };
            output: {
                file: {
                    blockIndex: number;
                    language: string;
                    fileName: string;
                    publicPath: string;
                    previewUrl: string;
                    contentType: string;
                    createdAt: string;
                };
                alreadyExisted: boolean;
            };
            outputFormat: "json";
            status: import('hono/utils/http-status').ContentfulStatusCode;
        };
    };
}, "/"> | import('hono/types').MergeSchemaPath<{
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
}, "/"> | import('hono/types').MergeSchemaPath<{
    "/api/prompt-templates": {
        $get: {
            input: {};
            output: {
                data: {
                    id: string;
                    inputType: "text" | "textarea";
                    title: string;
                    placeholder: string;
                    prompt: string;
                }[];
            };
            outputFormat: "json";
            status: import('hono/utils/http-status').ContentfulStatusCode;
        };
    };
}, "/"> | import('hono/types').MergeSchemaPath<{
    "/api/system-status": {
        $get: {
            input: {};
            output: {
                status: "ok" | "degraded";
                checkedAt: string;
                checks: {
                    database: {
                        status: "error" | "ok" | "not-configured";
                        reason: "ok" | "not-configured" | "timeout" | "connection-failed" | "schema-check-failed" | "database-unavailable" | "healthz-unavailable" | "login-failed" | "read-failed" | "file-server-api-unavailable" | "public-unavailable" | "check-failed";
                        checkedAt: string;
                        connection: {
                            status: "error" | "ok" | "not-configured";
                            reason: "ok" | "not-configured" | "timeout" | "connection-failed" | "schema-check-failed" | "database-unavailable" | "healthz-unavailable" | "login-failed" | "read-failed" | "file-server-api-unavailable" | "public-unavailable" | "check-failed";
                            checkedAt: string;
                        };
                        schema: {
                            status: "error" | "ok" | "not-configured";
                            reason: "ok" | "not-configured" | "timeout" | "connection-failed" | "schema-check-failed" | "database-unavailable" | "healthz-unavailable" | "login-failed" | "read-failed" | "file-server-api-unavailable" | "public-unavailable" | "check-failed";
                            checkedAt: string;
                        };
                    };
                    fileServerHealth: {
                        status: "error" | "ok" | "not-configured";
                        reason: "ok" | "not-configured" | "timeout" | "connection-failed" | "schema-check-failed" | "database-unavailable" | "healthz-unavailable" | "login-failed" | "read-failed" | "file-server-api-unavailable" | "public-unavailable" | "check-failed";
                        checkedAt: string;
                    };
                    fileServerApi: {
                        status: "error" | "ok" | "not-configured";
                        reason: "ok" | "not-configured" | "timeout" | "connection-failed" | "schema-check-failed" | "database-unavailable" | "healthz-unavailable" | "login-failed" | "read-failed" | "file-server-api-unavailable" | "public-unavailable" | "check-failed";
                        checkedAt: string;
                        login: {
                            status: "error" | "ok" | "not-configured";
                            reason: "ok" | "not-configured" | "timeout" | "connection-failed" | "schema-check-failed" | "database-unavailable" | "healthz-unavailable" | "login-failed" | "read-failed" | "file-server-api-unavailable" | "public-unavailable" | "check-failed";
                            checkedAt: string;
                        };
                        read: {
                            status: "error" | "ok" | "not-configured";
                            reason: "ok" | "not-configured" | "timeout" | "connection-failed" | "schema-check-failed" | "database-unavailable" | "healthz-unavailable" | "login-failed" | "read-failed" | "file-server-api-unavailable" | "public-unavailable" | "check-failed";
                            checkedAt: string;
                        };
                    };
                    fileServerPublic: {
                        status: "error" | "ok" | "not-configured";
                        reason: "ok" | "not-configured" | "timeout" | "connection-failed" | "schema-check-failed" | "database-unavailable" | "healthz-unavailable" | "login-failed" | "read-failed" | "file-server-api-unavailable" | "public-unavailable" | "check-failed";
                        checkedAt: string;
                    };
                };
            };
            outputFormat: "json";
            status: 200;
        } | {
            input: {};
            output: {
                error: string;
            };
            outputFormat: "json";
            status: 503;
        };
    };
}, "/"> | import('hono/types').MergeSchemaPath<{
    "*": {
        $get: {
            input: {};
            output: {};
            outputFormat: string;
            status: import('hono/utils/http-status').StatusCode;
        };
    };
}, "/">, "/", "*">;
export type AppType = typeof routes;
export default app;
