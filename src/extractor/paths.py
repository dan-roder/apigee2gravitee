"""
Deterministic output path helpers for Tool 1.
"""

from __future__ import annotations

import os
import re


def safe_filename(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', name)


def join_safe(root: str, *parts: str) -> str:
    return os.path.join(root, *[safe_filename(p) for p in parts])


def credential_identity(developer_email: str, app_name: str, consumer_key: str) -> str:
    return f'{developer_email}/{app_name}/{consumer_key}'


def credential_file_path(ir_dir: str, developer_email: str, app_name: str, consumer_key: str) -> str:
    return join_safe(ir_dir, 'credentials', developer_email, app_name, f'{consumer_key}.json')


def protected_secret_dir(ir_dir: str, developer_email: str, app_name: str, consumer_key: str) -> str:
    return join_safe(ir_dir, '_protected', 'credentials', developer_email, app_name, consumer_key)


def failed_artifact_dir(ir_dir: str, artifact_type: str, artifact_id: str) -> str:
    return join_safe(ir_dir, '_failed-artifacts', artifact_type, artifact_id)
