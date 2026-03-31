"""
Shared extractor run context types.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class RunConfig:
    data_dir: str
    ir_dir: str
    org: str = ''
    environment: str = ''
    verbose: bool = False


@dataclass
class RunContext:
    config: RunConfig
    extracted_at: str
    failures: list = field(default_factory=list)
