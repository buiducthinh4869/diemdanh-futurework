#!/usr/bin/env python3
"""Tải danh sách chủ (tab DanhSach) từ Google Sheet về file Excel cập nhật.

Cách 1 (mặc định) – qua endpoint admin của Web App, cần ADMIN_KEY:
    set FUTUREWORK_ADMIN_KEY=<ADMIN_KEY>        (Windows cmd)
    python export_danhsach.py                    -> DanhSach_YYYY-MM-DD.xlsx
    python export_danhsach.py -o ds.xlsx --url https://script.google.com/macros/s/.../exec

Cách 2 – qua link xuất CSV của Google Sheet (chỉ chạy được khi bạn đã chia sẻ
sheet cho "Bất kỳ ai có đường liên kết" hoặc dán cookie đăng nhập – thường không nên):
    python export_danhsach.py --csv-sheet-id <SHEET_ID>

Khóa không bao giờ được ghi vào file; nếu không có biến môi trường, script sẽ hỏi.
"""
import argparse
import datetime
import getpass
import io
import json
import os
import re
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def default_url():
    """Đọc API_URL từ config.js (nếu đã cấu hình)."""
    try:
        txt = open(os.path.join(HERE, "config.js"), encoding="utf-8").read()
        m = re.search(r"API_URL:\s*'([^']+)'", txt)
        return m.group(1) if m else ""
    except OSError:
        return ""


def fetch_admin(url, key):
    q = urllib.parse.urlencode({"action": "adminExport", "key": key})
    with urllib.request.urlopen(f"{url}?{q}", timeout=120) as r:
        data = json.loads(r.read().decode("utf-8"))
    if not data.get("ok"):
        raise SystemExit(f"Server từ chối: {data.get('message') or data}")
    return data["headers"], data["rows"]


def fetch_csv(sheet_id):
    import csv

    q = urllib.parse.urlencode({"tqx": "out:csv", "sheet": "DanhSach"})
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq?{q}"
    with urllib.request.urlopen(url, timeout=120) as r:
        text = r.read().decode("utf-8")
    rows = list(csv.reader(io.StringIO(text)))
    return rows[0], rows[1:]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=default_url(), help="URL Web App (mặc định lấy từ config.js)")
    ap.add_argument("--csv-sheet-id", help="Dùng link xuất CSV của Google Sheet thay vì endpoint admin")
    ap.add_argument("-o", "--output", default=f"DanhSach_{datetime.date.today().isoformat()}.xlsx")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    if args.csv_sheet_id:
        headers, rows = fetch_csv(args.csv_sheet_id)
    else:
        if not args.url:
            raise SystemExit("Chưa có URL Web App: dùng --url hoặc điền API_URL trong config.js")
        key = os.environ.get("FUTUREWORK_ADMIN_KEY") or getpass.getpass("ADMIN_KEY: ")
        headers, rows = fetch_admin(args.url, key.strip())

    import pandas as pd

    df = pd.DataFrame(rows, columns=headers)
    with pd.ExcelWriter(args.output, engine="openpyxl") as xw:
        df.to_excel(xw, sheet_name="DanhSach", index=False)
        ws = xw.sheets["DanhSach"]
        ws.freeze_panes = "A2"
        for i, col in enumerate(df.columns, start=1):
            width = max([len(str(col))] + [len(str(v)) for v in df[col].head(300)]) + 2
            ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = min(width, 45)
    print(f"Đã ghi {len(df)} dòng -> {os.path.abspath(args.output)}")
    if "Nguồn" in df.columns:
        print(df["Nguồn"].value_counts().to_string())


if __name__ == "__main__":
    main()
