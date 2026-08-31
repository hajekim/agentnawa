"""Connection config store: the whole connections list, persisted as one JSON.

Backend by env: CONFIG_BUCKET set -> single JSON blob (name from CONFIG_OBJECT,
default "connections.json") in that GCS bucket; else a local JSON file at
CONFIG_PATH (default "config.json"). On-disk/blob shape: {"connections": [...]}.
Missing file/blob => empty list.
"""
import json
import os

# ponytail: whole-object read/write, no locking -- admin writes are rare; add
# per-object/optimistic locking only if concurrent admin writers ever appear.


def _blob():
    from google.cloud import storage
    bucket = storage.Client().bucket(os.getenv("CONFIG_BUCKET"))
    return bucket.blob(os.getenv("CONFIG_OBJECT", "connections.json"))


def load() -> list[dict]:
    if os.getenv("CONFIG_BUCKET"):
        blob = _blob()
        if not blob.exists():
            return []
        return json.loads(blob.download_as_text()).get("connections", [])
    path = os.getenv("CONFIG_PATH", "config.json")
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return json.load(f).get("connections", [])


def save(connections: list[dict]) -> None:
    payload = json.dumps({"connections": connections})
    if os.getenv("CONFIG_BUCKET"):
        _blob().upload_from_string(payload, content_type="application/json")
        return
    with open(os.getenv("CONFIG_PATH", "config.json"), "w") as f:
        f.write(payload)


if __name__ == "__main__":
    import tempfile
    os.environ.pop("CONFIG_BUCKET", None)  # force local path even if env set it
    os.environ["CONFIG_PATH"] = os.path.join(tempfile.mkdtemp(), "cfg.json")
    assert load() == [], "missing file must load as empty list"
    conns = [{"id": "a1b2c3d4", "project_id": "p", "app_id": "app", "cid": "", "label": ""}]
    save(conns)
    assert load() == conns, "save->load round-trip mismatch"
    print("config_store self-check ok")
