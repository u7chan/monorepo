import { GithubServiceError } from "../services/github";

export function deployErrorResponse(error: unknown): Response {
  if (error instanceof GithubServiceError) {
    return Response.json(
      { error: "Deploy request failed", message: error.message },
      { status: error.status },
    );
  }

  console.error("Deploy request failed:", error);
  return Response.json(
    { error: "Deploy request failed", message: "Unexpected error" },
    { status: 500 },
  );
}

export function crossOriginResponse(): Response {
  return Response.json({ error: "Cross-origin request is not allowed" }, { status: 403 });
}
