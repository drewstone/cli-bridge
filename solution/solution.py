import json
import urllib.error
import urllib.parse
import urllib.request


def get_subscriber(base_url: str, api_key: str, subscriber_id: str) -> dict:
    encoded_id = urllib.parse.quote(subscriber_id, safe="")
    url = f"{base_url.rstrip('/')}/v2/subscribers/{encoded_id}"

    req = urllib.request.Request(
        url,
        method="GET",
        headers={
            "Authorization": f"ApiKey {api_key}",
            "Accept": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(req) as resp:
            body = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        error_body = {}
        try:
            error_body = json.loads(exc.read())
        except (json.JSONDecodeError, AttributeError):
            pass
        if isinstance(error_body, dict):
            return error_body
        raise

    if isinstance(body, dict) and "data" in body:
        candidate = body["data"]
        if isinstance(candidate, dict) and "_organizationId" in candidate:
            return candidate

    return body
