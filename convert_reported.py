#!/usr/bin/env python3
"""
Converte um resultados.json (saida do scraper) para o JSON aceito pelo
botao "Import as Reported" da aba Reporteds do NightWatch.

Formato de saida: objeto { uid: { status, timestamp, reviewer, userData } }

Uso:
    python3 convert_reported.py resultados.json saida_REPORTED.json [reviewer]
"""
import json
import sys
import time


def convert(input_path, output_path, reviewer="system"):
    with open(input_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, list):
        raise ValueError("resultados.json deveria conter uma lista de usuarios")

    now = int(time.time() * 1000)  # ms, igual Date.now() do JS
    out = {}
    skipped = 0

    for item in data:
        if item.get("status") != "ok":
            skipped += 1
            continue

        account = item.get("account") or {}
        profile = item.get("profile") or {}

        uid = account.get("user_id")
        username = item.get("username") or profile.get("handle", "").lstrip("@")
        sec_uid = account.get("sec_uid")
        nickname = profile.get("display_name") or username

        if not uid:
            skipped += 1
            continue

        out[uid] = {
            "status": "reported",
            "timestamp": now,
            "reviewer": reviewer,
            "userData": {
                "nickname": nickname,
                "unique_id": username,
                "sec_uid": sec_uid,
            },
        }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print(f"OK: {len(out)} usuarios convertidos, {skipped} ignorados.")
    print(f"Arquivo gerado: {output_path}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Uso: python3 convert_reported.py resultados.json saida_REPORTED.json [reviewer]")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    reviewer = sys.argv[3] if len(sys.argv) > 3 else "system"

    convert(input_path, output_path, reviewer)

