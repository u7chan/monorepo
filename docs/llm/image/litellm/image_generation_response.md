# Example Responses

`gpt-image-1`:

```sh
HTTP/1.1 200 OK
date: Sat, 17 Jan 2026 07:19:15 GMT
server: uvicorn
content-length: 2335634
content-type: application/json
x-litellm-call-id: 075f47e7-61ce-491a-9493-0e89df44be56
x-litellm-model-id: 82ed1e69-0c95-4626-9fc9-1aae46e0c6de
x-litellm-model-api-base: https://api.openai.com
x-litellm-version: 1.80.13
x-litellm-response-cost: 0.042300000000000004
x-litellm-key-spend: 1.0644761649999999
x-litellm-response-duration-ms: 20492.051
Connection: close

{
  "created": 1768634374,
  "background": null,
  "data": [
     {
      "b64_json": "iVBORw0KGgoAAAANSUhEUgAABAA ..."
     }
  ],
  "output_format": "png",
  "quality": "medium",
  "size": "1024x1024",
  "usage": {
    "total_tokens": 1068,
    "input_tokens": 12,
    "input_tokens_details": {
      "image_tokens": 0,
      "text_tokens": 12
    },
    "output_tokens": 1056
  }
}
```

`dall-e-3`:

```sh
HTTP/1.1 200 OK
date: Sat, 17 Jan 2026 07:29:32 GMT
server: uvicorn
content-length: 1321
content-type: application/json
x-litellm-call-id: 15854271-48a8-4b61-9b2a-caccdc8b1042
x-litellm-model-id: 716bc389-f77b-456e-b4e7-b3beabad63e5
x-litellm-model-api-base: https://api.openai.com
x-litellm-version: 1.80.13
x-litellm-response-cost: 0.0399999238144
x-litellm-key-spend: 1.1666990328143998
x-litellm-response-duration-ms: 16778.23
Connection: close

{
  "created": 1768634990,
  "background": null,
  "data": [
    {
      "b64_json": null,
      "revised_prompt": "Envision a heartwarming image of a baby sea otter. The otter should be extraordinarily cute, its fur soft and fluffy, capturing the nuances of its distinct aquatic mammalian features. The shimmering, dense fur colored in a majestic shade of brown with a hint of tan, giving it an almost glowing aura. It might be floating on its back in the calm, sun-glistened sea with its tiny paws lifted playfully, illustrating the inherently frolicsome nature of otters. Tiny droplets of water may pearl atop its coat reflecting the radiant sun, adding a magical touch to this endearing image.",
      "url": "https://oaidalleapiprodscus.blob.core.windows.net/private/org-h1cHZxKO7UQLVLNqU2R2MTP3/user-dummydummy/img-dummydummy.png"
    }
  ],
  "output_format": null,
  "quality": null,
  "size": null,
  "usage": {
    "total_tokens": 0,
    "input_tokens": 0,
    "input_tokens_details": {
      "image_tokens": 0,
      "text_tokens": 0
    },
    "output_tokens": 0
  }
}
```
