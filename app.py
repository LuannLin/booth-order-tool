from __future__ import annotations

import csv
import json
import os
import secrets
import sqlite3
import threading
import time
from datetime import datetime
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
DATA_DIR = Path(os.environ.get("BOOTH_DATA_DIR", BASE_DIR / "data"))
DB_PATH = DATA_DIR / "booth.sqlite3"
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8765"))

JSON_HEADERS = {"Content-Type": "application/json; charset=utf-8"}
ADMIN_COOKIE = "booth_admin"
SESSIONS: set[str] = set()
DB_LOCK = threading.Lock()


def now_text() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    with DB_LOCK, connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                price REAL NOT NULL DEFAULT 0,
                stock INTEGER NOT NULL DEFAULT 0,
                category TEXT NOT NULL DEFAULT '',
                author TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '',
                image TEXT NOT NULL DEFAULT '',
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pickup_code TEXT NOT NULL UNIQUE,
                receive_type TEXT NOT NULL,
                phone TEXT NOT NULL DEFAULT '',
                phone_tail TEXT NOT NULL DEFAULT '',
                pickup_time TEXT NOT NULL DEFAULT '',
                payment_method TEXT NOT NULL,
                payment_status TEXT NOT NULL DEFAULT 'pending',
                order_status TEXT NOT NULL DEFAULT 'new',
                total REAL NOT NULL DEFAULT 0,
                note TEXT NOT NULL DEFAULT '',
                ready_at TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS order_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id INTEGER NOT NULL,
                product_id INTEGER,
                name TEXT NOT NULL,
                price REAL NOT NULL,
                quantity INTEGER NOT NULL,
                author TEXT NOT NULL DEFAULT '',
                category TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '',
                FOREIGN KEY(order_id) REFERENCES orders(id)
            );
            """
        )
        defaults = {
            "booth_name": "星河临时摊",
            "welcome": "欢迎光临，选好后拿取单码来摊位核验付款取货。",
            "logo": "",
            "wechat_qr": "",
            "alipay_qr": "",
            "admin_password": "123456",
        }
        for key, value in defaults.items():
            conn.execute(
                "INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)",
                (key, value),
            )
        order_columns = {row["name"] for row in conn.execute("PRAGMA table_info(orders)").fetchall()}
        if "phone_tail" not in order_columns:
            conn.execute("ALTER TABLE orders ADD COLUMN phone_tail TEXT NOT NULL DEFAULT ''")
        if "pickup_time" not in order_columns:
            conn.execute("ALTER TABLE orders ADD COLUMN pickup_time TEXT NOT NULL DEFAULT ''")
        if "ready_at" not in order_columns:
            conn.execute("ALTER TABLE orders ADD COLUMN ready_at TEXT NOT NULL DEFAULT ''")
        existing = conn.execute("SELECT COUNT(*) AS c FROM products").fetchone()["c"]
        if existing == 0:
            sample_time = now_text()
            samples = [
                ("流星徽章", 15, 12, "徽章", "主催", "闪亮,示例", ""),
                ("月光贴纸包", 20, 8, "贴纸", "合摊A", "套组,示例", ""),
                ("云朵小卡", 10, 0, "纸品", "合摊B", "售罄示例", ""),
            ]
            conn.executemany(
                """
                INSERT INTO products(name, price, stock, category, author, tags, image, created_at, updated_at)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [(*row, sample_time, sample_time) for row in samples],
            )
        conn.commit()


def read_body(handler: BaseHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length", "0"))
    if length <= 0:
        return {}
    raw = handler.rfile.read(length)
    return json.loads(raw.decode("utf-8"))


def write_json(handler: BaseHTTPRequestHandler, status: int, payload: dict | list) -> None:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    for key, value in JSON_HEADERS.items():
        handler.send_header(key, value)
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def write_text(handler: BaseHTTPRequestHandler, status: int, text: str, content_type: str) -> None:
    data = text.encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def settings_dict(conn: sqlite3.Connection, public: bool = True) -> dict:
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    result = {row["key"]: row["value"] for row in rows}
    if public:
        result.pop("admin_password", None)
    return result


def require_admin(handler: BaseHTTPRequestHandler) -> bool:
    jar = cookies.SimpleCookie(handler.headers.get("Cookie"))
    token = jar.get(ADMIN_COOKIE)
    if token and token.value in SESSIONS:
        return True
    write_json(handler, 401, {"error": "需要先登录后台"})
    return False


def row_to_product(row: sqlite3.Row) -> dict:
    data = dict(row)
    data["active"] = bool(data["active"])
    return data


def list_products(conn: sqlite3.Connection, admin: bool = False) -> list[dict]:
    query = "SELECT * FROM products"
    if not admin:
        query += " WHERE active = 1"
    query += " ORDER BY category, author, id DESC"
    return [row_to_product(row) for row in conn.execute(query).fetchall()]


def generate_pickup_code(conn: sqlite3.Connection) -> str:
    prefix = datetime.now().strftime("%m%d")
    count = conn.execute(
        "SELECT COUNT(*) AS c FROM orders WHERE pickup_code LIKE ?",
        (f"{prefix}-%",),
    ).fetchone()["c"]
    return f"{prefix}-{count + 1:03d}"


def order_detail(conn: sqlite3.Connection, order_id: int) -> dict | None:
    order = conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if not order:
        return None
    items = conn.execute(
        "SELECT * FROM order_items WHERE order_id = ? ORDER BY id",
        (order_id,),
    ).fetchall()
    data = dict(order)
    data["items"] = [dict(item) for item in items]
    return data


def list_orders(conn: sqlite3.Connection, order_date: str = "") -> list[dict]:
    params: list[str] = []
    query = "SELECT * FROM orders"
    if order_date:
        query += " WHERE substr(created_at, 1, 10) = ?"
        params.append(order_date)
    query += " ORDER BY id DESC"
    orders = conn.execute(query, params).fetchall()
    result = []
    for order in orders:
        data = dict(order)
        items = conn.execute(
            "SELECT * FROM order_items WHERE order_id = ? ORDER BY id",
            (order["id"],),
        ).fetchall()
        data["items"] = [dict(item) for item in items]
        result.append(data)
    return result


def sales_stats(conn: sqlite3.Connection, order_date: str = "") -> dict:
    params: list[str] = []
    where = "WHERE o.order_status != 'cancelled'"
    if order_date:
        where += " AND substr(o.created_at, 1, 10) = ?"
        params.append(order_date)
    totals = conn.execute(
        f"""
        SELECT
            COUNT(DISTINCT o.id) AS order_count,
            COALESCE(SUM(oi.quantity), 0) AS sold_quantity,
            COALESCE(ROUND(SUM(oi.price * oi.quantity), 2), 0) AS sales_total
        FROM orders o
        LEFT JOIN order_items oi ON oi.order_id = o.id
        {where}
        """,
        params,
    ).fetchone()
    products = conn.execute(
        f"""
        SELECT
            oi.name,
            oi.author,
            oi.category,
            oi.price,
            SUM(oi.quantity) AS sold_quantity,
            ROUND(SUM(oi.price * oi.quantity), 2) AS sales_total
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        {where}
        GROUP BY oi.name, oi.author, oi.category, oi.price
        ORDER BY sales_total DESC, sold_quantity DESC, oi.name
        """,
        params,
    ).fetchall()
    return {
        "order_count": totals["order_count"],
        "sold_quantity": totals["sold_quantity"],
        "sales_total": totals["sales_total"],
        "products": [dict(row) for row in products],
        "orders": list_orders(conn, order_date=order_date),
    }


def validate_product_payload(payload: dict) -> tuple[str, float, int, str, str, str, str, bool]:
    name = str(payload.get("name", "")).strip()
    if not name:
        raise ValueError("商品名不能为空")
    price = round(float(payload.get("price", 0)), 2)
    stock = int(payload.get("stock", 0))
    if price < 0 or stock < 0:
        raise ValueError("价格和库存不能为负数")
    category = str(payload.get("category", "")).strip()
    author = str(payload.get("author", "")).strip()
    tags = str(payload.get("tags", "")).strip()
    image = str(payload.get("image", "")).strip()
    active = bool(payload.get("active", True))
    return name, price, stock, category, author, tags, image, active


class BoothHandler(BaseHTTPRequestHandler):
    server_version = "BoothOrderTool/0.1"

    def log_message(self, format: str, *args) -> None:
        return

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/":
            return self.serve_file("index.html")
        if path == "/admin":
            return self.serve_file("admin.html")
        if path.startswith("/public/"):
            return self.serve_file(path.removeprefix("/public/"))
        if path == "/api/settings":
            with DB_LOCK, connect() as conn:
                return write_json(self, 200, settings_dict(conn, public=True))
        if path == "/api/products":
            with DB_LOCK, connect() as conn:
                return write_json(self, 200, list_products(conn, admin=False))
        if path == "/api/admin/me":
            return write_json(self, 200, {"ok": self.is_admin()})
        if path == "/api/admin/products":
            if not require_admin(self):
                return
            with DB_LOCK, connect() as conn:
                return write_json(self, 200, list_products(conn, admin=True))
        if path == "/api/admin/orders":
            if not require_admin(self):
                return
            query = parse_qs(parsed.query)
            order_date = query.get("date", [""])[0]
            with DB_LOCK, connect() as conn:
                return write_json(self, 200, list_orders(conn, order_date=order_date))
        if path == "/api/admin/settings":
            if not require_admin(self):
                return
            with DB_LOCK, connect() as conn:
                return write_json(self, 200, settings_dict(conn, public=False))
        if path == "/api/admin/sales":
            if not require_admin(self):
                return
            query = parse_qs(parsed.query)
            order_date = query.get("date", [""])[0]
            with DB_LOCK, connect() as conn:
                return write_json(self, 200, sales_stats(conn, order_date=order_date))
        if path == "/api/admin/export":
            if not require_admin(self):
                return
            return self.export_csv()
        if path == "/api/admin/export-summary":
            if not require_admin(self):
                return
            return self.export_summary_csv()
        write_json(self, 404, {"error": "没有找到这个页面"})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/admin/login":
                return self.login()
            if path == "/api/admin/logout":
                return self.logout()
            if path == "/api/orders":
                return self.create_order()
            if path == "/api/admin/products":
                if not require_admin(self):
                    return
                return self.create_product()
            if path == "/api/admin/settings":
                if not require_admin(self):
                    return
                return self.update_settings()
        except (ValueError, json.JSONDecodeError) as exc:
            return write_json(self, 400, {"error": str(exc)})
        write_json(self, 404, {"error": "没有找到这个接口"})

    def do_PATCH(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path.startswith("/api/admin/products/"):
                if not require_admin(self):
                    return
                product_id = int(path.rsplit("/", 1)[-1])
                return self.update_product(product_id)
            if path.startswith("/api/admin/orders/"):
                if not require_admin(self):
                    return
                order_id = int(path.rsplit("/", 1)[-1])
                return self.update_order(order_id)
        except (ValueError, json.JSONDecodeError) as exc:
            return write_json(self, 400, {"error": str(exc)})
        write_json(self, 404, {"error": "没有找到这个接口"})

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path.startswith("/api/admin/products/"):
                if not require_admin(self):
                    return
                product_id = int(path.rsplit("/", 1)[-1])
                with DB_LOCK, connect() as conn:
                    conn.execute("DELETE FROM products WHERE id = ?", (product_id,))
                    conn.commit()
                return write_json(self, 200, {"ok": True})
        except ValueError as exc:
            return write_json(self, 400, {"error": str(exc)})
        write_json(self, 404, {"error": "没有找到这个接口"})

    def is_admin(self) -> bool:
        jar = cookies.SimpleCookie(self.headers.get("Cookie"))
        token = jar.get(ADMIN_COOKIE)
        return bool(token and token.value in SESSIONS)

    def serve_file(self, filename: str) -> None:
        safe = filename.strip("/").replace("\\", "/")
        path = (PUBLIC_DIR / safe).resolve()
        if PUBLIC_DIR.resolve() not in path.parents and path != PUBLIC_DIR.resolve():
            return write_json(self, 403, {"error": "不能访问这个文件"})
        if not path.exists() or path.is_dir():
            return write_json(self, 404, {"error": "文件不存在"})
        content_type = "text/plain; charset=utf-8"
        if path.suffix == ".html":
            content_type = "text/html; charset=utf-8"
        elif path.suffix == ".css":
            content_type = "text/css; charset=utf-8"
        elif path.suffix == ".js":
            content_type = "application/javascript; charset=utf-8"
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def login(self) -> None:
        payload = read_body(self)
        password = str(payload.get("password", ""))
        with DB_LOCK, connect() as conn:
            expected = settings_dict(conn, public=False).get("admin_password", "123456")
        if password != expected:
            return write_json(self, 403, {"error": "密码不对"})
        token = secrets.token_urlsafe(24)
        SESSIONS.add(token)
        data = json.dumps({"ok": True}, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Set-Cookie", f"{ADMIN_COOKIE}={token}; Path=/; SameSite=Lax")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def logout(self) -> None:
        jar = cookies.SimpleCookie(self.headers.get("Cookie"))
        token = jar.get(ADMIN_COOKIE)
        if token:
            SESSIONS.discard(token.value)
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Set-Cookie", f"{ADMIN_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax")
        self.end_headers()
        self.wfile.write(b'{"ok": true}')

    def create_order(self) -> None:
        payload = read_body(self)
        items = payload.get("items", [])
        if not isinstance(items, list) or not items:
            raise ValueError("购物车是空的")
        receive_type = str(payload.get("receive_type", "now"))
        phone = str(payload.get("phone", "")).strip()
        phone_tail = str(payload.get("phone_tail", "")).strip()
        pickup_time = str(payload.get("pickup_time", "")).strip()
        payment_method = str(payload.get("payment_method", "wechat"))
        note = str(payload.get("note", "")).strip()
        if receive_type not in {"now", "later"}:
            raise ValueError("领取方式不正确")
        if receive_type == "later" and not phone:
            raise ValueError("稍后领取需要填写电话")
        if receive_type == "later" and (not phone.isdigit() or len(phone) != 11):
            raise ValueError("稍后领取需要填写 11 位手机号")
        if receive_type == "now" and (not phone_tail.isdigit() or len(phone_tail) != 4):
            raise ValueError("现在领取需要填写手机号后四位")
        if receive_type == "later" and not pickup_time:
            raise ValueError("稍后领取需要选择预计领取时间")
        if receive_type == "later":
            phone_tail = phone[-4:]
        else:
            phone = ""
            pickup_time = ""
        if payment_method not in {"wechat", "alipay", "cash"}:
            raise ValueError("支付方式不正确")
        with DB_LOCK, connect() as conn:
            product_ids = [int(item.get("product_id")) for item in items]
            placeholders = ",".join("?" for _ in product_ids)
            rows = conn.execute(
                f"SELECT * FROM products WHERE id IN ({placeholders}) AND active = 1",
                product_ids,
            ).fetchall()
            products = {row["id"]: row for row in rows}
            clean_items = []
            total = 0.0
            for item in items:
                product_id = int(item.get("product_id"))
                quantity = int(item.get("quantity", 1))
                if quantity <= 0:
                    raise ValueError("数量不正确")
                product = products.get(product_id)
                if not product:
                    raise ValueError("有商品已经下架")
                if product["stock"] < quantity:
                    raise ValueError(f"{product['name']} 库存不够了")
                line_total = round(float(product["price"]) * quantity, 2)
                total += line_total
                clean_items.append((product, quantity))
            pickup_code = generate_pickup_code(conn)
            created = now_text()
            payment_status = "cash_pending" if payment_method == "cash" else "pending"
            cur = conn.execute(
                """
                INSERT INTO orders(pickup_code, receive_type, phone, phone_tail, pickup_time, payment_method, payment_status, order_status, total, note, created_at, updated_at)
                VALUES(?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?)
                """,
                (pickup_code, receive_type, phone, phone_tail, pickup_time, payment_method, payment_status, round(total, 2), note, created, created),
            )
            order_id = cur.lastrowid
            for product, quantity in clean_items:
                conn.execute(
                    """
                    INSERT INTO order_items(order_id, product_id, name, price, quantity, author, category, tags)
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        order_id,
                        product["id"],
                        product["name"],
                        product["price"],
                        quantity,
                        product["author"],
                        product["category"],
                        product["tags"],
                    ),
                )
                conn.execute(
                    "UPDATE products SET stock = stock - ?, updated_at = ? WHERE id = ?",
                    (quantity, created, product["id"]),
                )
            conn.commit()
            detail = order_detail(conn, order_id)
        write_json(self, 201, detail)

    def create_product(self) -> None:
        payload = read_body(self)
        fields = validate_product_payload(payload)
        stamp = now_text()
        with DB_LOCK, connect() as conn:
            cur = conn.execute(
                """
                INSERT INTO products(name, price, stock, category, author, tags, image, active, created_at, updated_at)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (*fields, stamp, stamp),
            )
            conn.commit()
            product = conn.execute("SELECT * FROM products WHERE id = ?", (cur.lastrowid,)).fetchone()
        write_json(self, 201, row_to_product(product))

    def update_product(self, product_id: int) -> None:
        payload = read_body(self)
        fields = validate_product_payload(payload)
        stamp = now_text()
        with DB_LOCK, connect() as conn:
            conn.execute(
                """
                UPDATE products
                SET name=?, price=?, stock=?, category=?, author=?, tags=?, image=?, active=?, updated_at=?
                WHERE id=?
                """,
                (*fields, stamp, product_id),
            )
            conn.commit()
            product = conn.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
        if not product:
            return write_json(self, 404, {"error": "商品不存在"})
        write_json(self, 200, row_to_product(product))

    def update_order(self, order_id: int) -> None:
        payload = read_body(self)
        allowed_status = {"new", "picking", "ready", "completed", "cancelled"}
        allowed_payment = {"pending", "verified", "cash_pending", "cash_received"}
        fields = []
        params = []
        if "order_status" in payload:
            value = str(payload["order_status"])
            if value not in allowed_status:
                raise ValueError("订单状态不正确")
            fields.append("order_status=?")
            params.append(value)
            if value == "ready":
                fields.append("ready_at=?")
                params.append(now_text())
        if "payment_status" in payload:
            value = str(payload["payment_status"])
            if value not in allowed_payment:
                raise ValueError("支付状态不正确")
            fields.append("payment_status=?")
            params.append(value)
        if not fields:
            raise ValueError("没有要更新的内容")
        fields.append("updated_at=?")
        params.append(now_text())
        params.append(order_id)
        with DB_LOCK, connect() as conn:
            conn.execute(f"UPDATE orders SET {', '.join(fields)} WHERE id=?", params)
            conn.commit()
            detail = order_detail(conn, order_id)
        if not detail:
            return write_json(self, 404, {"error": "订单不存在"})
        write_json(self, 200, detail)

    def update_settings(self) -> None:
        payload = read_body(self)
        allowed = {"booth_name", "welcome", "logo", "wechat_qr", "alipay_qr", "admin_password"}
        with DB_LOCK, connect() as conn:
            for key, value in payload.items():
                if key in allowed:
                    conn.execute(
                        "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        (key, str(value)),
                    )
            conn.commit()
            data = settings_dict(conn, public=False)
        write_json(self, 200, data)

    def export_csv(self) -> None:
        with DB_LOCK, connect() as conn:
            rows = conn.execute(
                """
                SELECT
                    o.pickup_code, o.created_at, o.order_status, o.payment_method, o.payment_status,
                    o.receive_type, o.phone, o.phone_tail, o.pickup_time, oi.name, oi.price, oi.quantity,
                    ROUND(oi.price * oi.quantity, 2) AS line_total,
                    oi.author, oi.category, oi.tags, o.total
                FROM orders o
                JOIN order_items oi ON oi.order_id = o.id
                ORDER BY o.id DESC, oi.id
                """
            ).fetchall()
        output = []
        header = [
            "取单码", "下单时间", "订单状态", "支付方式", "支付状态", "领取方式", "电话", "尾号", "预计领取时间",
            "商品名", "单价", "数量", "小计", "作者", "分类", "标签", "订单总价",
        ]
        output.append(header)
        for row in rows:
            output.append([row[key] for key in row.keys()])
        text_lines = []
        for row in output:
            text_lines.append(",".join(csv_escape(value) for value in row))
        data = ("\ufeff" + "\r\n".join(text_lines)).encode("utf-8")
        filename = f"booth-sales-{datetime.now().strftime('%Y%m%d-%H%M%S')}.csv"
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def export_summary_csv(self) -> None:
        with DB_LOCK, connect() as conn:
            rows = conn.execute(
                """
                SELECT
                    oi.name,
                    oi.author,
                    oi.category,
                    oi.tags,
                    oi.price,
                    SUM(oi.quantity) AS sold_quantity,
                    ROUND(SUM(oi.price * oi.quantity), 2) AS sales_total
                FROM order_items oi
                JOIN orders o ON o.id = oi.order_id
                WHERE o.order_status != 'cancelled'
                GROUP BY oi.name, oi.author, oi.category, oi.tags, oi.price
                ORDER BY oi.author, oi.category, oi.name, oi.price
                """
            ).fetchall()
            total = conn.execute(
                """
                SELECT
                    COALESCE(SUM(oi.quantity), 0) AS sold_quantity,
                    COALESCE(ROUND(SUM(oi.price * oi.quantity), 2), 0) AS sales_total
                FROM order_items oi
                JOIN orders o ON o.id = oi.order_id
                WHERE o.order_status != 'cancelled'
                """
            ).fetchone()
        output = [["商品名", "作者", "分类", "标签", "单价", "销量", "营业额"]]
        for row in rows:
            output.append([row[key] for key in row.keys()])
        output.append(["总计", "", "", "", "", total["sold_quantity"], total["sales_total"]])
        text_lines = [",".join(csv_escape(value) for value in row) for row in output]
        data = ("\ufeff" + "\r\n".join(text_lines)).encode("utf-8")
        filename = f"booth-summary-{datetime.now().strftime('%Y%m%d-%H%M%S')}.csv"
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def csv_escape(value) -> str:
    text = "" if value is None else str(value)
    if any(ch in text for ch in [",", '"', "\n", "\r"]):
        return '"' + text.replace('"', '""') + '"'
    return text


def main() -> None:
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), BoothHandler)
    print(f"漫展摆摊工具已启动： http://127.0.0.1:{PORT}")
    print(f"后台入口： http://127.0.0.1:{PORT}/admin")
    print("默认后台密码：123456，第一次使用请在后台设置里改掉。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
