import { describe, expect, test } from "bun:test"

import { fetchModelCatalog, parseModelCatalog } from "../src/siwc/catalog"
import { API_BASE_URL } from "../src/siwc/constants"
import { jsonResponse, recordingFetch } from "./helpers/http"

const CATALOG = {
  models: [
    { slug: "model-b", display_name: "Model B", visibility: "list" },
    { slug: "model-hidden", display_name: "Hidden", visibility: "hidden" },
    { slug: "model-a", display_name: "Model A", visibility: "list" },
  ],
}

describe("parseModelCatalog", () => {
  test("visibility が list のモデルだけをサーバーの順序で返す", () => {
    expect(parseModelCatalog(CATALOG)).toEqual([
      { slug: "model-b", displayName: "Model B" },
      { slug: "model-a", displayName: "Model A" },
    ])
  })

  test("display_name が無ければ slug を使う", () => {
    expect(
      parseModelCatalog({ models: [{ slug: "model-c", visibility: "list" }] }),
    ).toEqual([{ slug: "model-c", displayName: "model-c" }])
  })

  test("{ models: [...] } 以外はトップレベルのキー名を含めてエラーにする", () => {
    expect(() => parseModelCatalog({ data: [] })).toThrow(
      "top-level keys: data",
    )
  })
})

describe("fetchModelCatalog", () => {
  test("access token を Bearer で送る", async () => {
    const { fetch, requests } = recordingFetch(() => jsonResponse(CATALOG))

    const models = await fetchModelCatalog(fetch, {
      accessToken: "access-token",
    })

    expect(requests[0]?.url).toBe(`${API_BASE_URL}/models`)
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer access-token",
    )
    expect(models).toHaveLength(2)
  })

  test("非 2xx は status と code を保持する", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(
        {
          error: {
            code: "subscription_sharing_user_not_eligible",
            message: "not eligible",
          },
        },
        { status: 403 },
      ),
    )

    await expect(
      fetchModelCatalog(fetch, { accessToken: "access-token" }),
    ).rejects.toMatchObject({
      status: 403,
      code: "subscription_sharing_user_not_eligible",
      description: "not eligible",
    })
  })
})
