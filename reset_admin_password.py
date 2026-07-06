from __future__ import annotations

import sqlite3
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "booth.sqlite3"


def main() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            INSERT INTO settings(key, value)
            VALUES('admin_password', '123456')
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """
        )
        conn.commit()
    print("后台密码已重置为 123456")
    print(f"数据文件：{DB_PATH}")


if __name__ == "__main__":
    main()
