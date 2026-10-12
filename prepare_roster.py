#!/usr/bin/env python3
"""Gộp 2 file Excel (TUAF, TUEBA) thành apps-script/RosterData.gs.

Chạy:  python prepare_roster.py
Đầu vào: các file `*_Danh sách học viên học AI.xlsx` trong cùng thư mục.
Đầu ra : apps-script/RosterData.gs (chứa dữ liệu cá nhân + ADMIN_KEY_SEED,
         đã được .gitignore – KHÔNG commit).

Các bước: chuẩn hóa tên cột (Năm Sinh -> Năm sinh, Column1 -> Ghi chú), chuẩn
hóa Unicode NFC, ghép study_arm theo (Trường, Khoa) từ sheet Unit assignment,
kiểm tra ID, đối chiếu số lượng kỳ vọng.
"""
import glob
import json
import os
import re
import secrets
import sys
import unicodedata
import warnings

import pandas as pd

warnings.filterwarnings("ignore")
sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "apps-script", "RosterData.gs")

# Số lượng kỳ vọng (Trường, Đợt) -> số người
EXPECTED = {
    ("TUAF", "Đợt 1"): 64,
    ("TUAF", "Đợt 2"): 62,
    ("TUEBA", "Đợt 1"): 99,
    ("TUEBA", "Đợt 2"): 106,
}

FIELDS = [
    "ID học viên", "Trường", "Khoa", "Đợt học", "Họ và tên", "Năm sinh",
    "Giới tính", "Ngạch giảng viên", "Bộ môn", "Ghi chú", "study_arm",
]


def clean(v):
    """NaN -> '', NFC, bỏ khoảng trắng thừa."""
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return ""
    s = unicodedata.normalize("NFC", str(v))
    return re.sub(r"\s+", " ", s).strip()


def load_one(path):
    xl = pd.ExcelFile(path)
    p = xl.parse("Participant assignment", dtype=str)
    u = xl.parse("Unit assignment", dtype=str)
    p = p.rename(columns={"Năm Sinh": "Năm sinh", "Column1": "Ghi chú"})
    p = p.applymap(clean) if hasattr(p, "applymap") else p.map(clean)
    u = u.applymap(clean) if hasattr(u, "applymap") else u.map(clean)
    # Năm sinh đôi khi đọc ra "1974.0"
    p["Năm sinh"] = p["Năm sinh"].str.replace(r"\.0$", "", regex=True)
    arm = u[["Trường", "Khoa", "study_arm"]].drop_duplicates()
    if arm.duplicated(["Trường", "Khoa"]).any():
        raise SystemExit(f"Unit assignment có Khoa trùng trong {path}")
    return p.merge(arm, on=["Trường", "Khoa"], how="left")


def main():
    files = sorted(glob.glob(os.path.join(HERE, "*_Danh sách học viên học AI.xlsx")))
    if len(files) != 2:
        raise SystemExit(f"Cần đúng 2 file xlsx, tìm thấy {len(files)}: {files}")
    df = pd.concat([load_one(f) for f in files], ignore_index=True)

    # --- Kiểm tra ---
    problems = []
    if (df["ID học viên"] == "").any():
        problems.append("Có ID rỗng")
    dup = df[df["ID học viên"].duplicated(keep=False)]
    if len(dup):
        problems.append(f"ID trùng: {sorted(dup['ID học viên'].unique())}")
    no_arm = df[df["study_arm"].isna() | (df["study_arm"] == "")]
    if len(no_arm):
        problems.append(f"Không ghép được study_arm: {no_arm['ID học viên'].tolist()}")
    bad_dot = df[~df["Đợt học"].isin(["Đợt 1", "Đợt 2"])]
    if len(bad_dot):
        problems.append(f"Đợt học lạ: {bad_dot['Đợt học'].unique().tolist()}")
    bad_id = df[~df["ID học viên"].str.fullmatch(r"(TUAF|TUEBA)\d{4}")]
    if len(bad_id):
        problems.append(f"ID sai định dạng: {bad_id['ID học viên'].tolist()}")
    mismatch = df[df["ID học viên"].str.extract(r"^(TUAF|TUEBA)")[0] != df["Trường"]]
    if len(mismatch):
        problems.append(f"Tiền tố ID không khớp Trường: {mismatch['ID học viên'].tolist()}")

    tab = pd.crosstab(df["Trường"], df["Đợt học"], margins=True)
    print("Bảng Trường x Đợt:")
    print(tab.to_string())
    for (school, dot), want in EXPECTED.items():
        got = int(((df["Trường"] == school) & (df["Đợt học"] == dot)).sum())
        flag = "OK " if got == want else "LỆCH"
        print(f"  [{flag}] {school} {dot}: {got} (kỳ vọng {want})")
        if got != want:
            problems.append(f"{school} {dot}: {got} != {want}")
    if len(df) != 331:
        problems.append(f"Tổng {len(df)} != 331")
    print("\nstudy_arm x Đợt:")
    print(pd.crosstab(df["study_arm"], df["Đợt học"]).to_string())

    if problems:
        print("\nLỖI DỮ LIỆU:")
        for x in problems:
            print(" -", x)
        raise SystemExit(1)

    # --- ADMIN_KEY_SEED: giữ nguyên nếu đã có để không đổi khóa khi chạy lại ---
    seed = None
    if os.path.exists(OUT):
        m = re.search(r"ADMIN_KEY_SEED = '([A-Za-z0-9]{16})'", open(OUT, encoding="utf-8").read())
        if m:
            seed = m.group(1)
    if not seed:
        alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"
        seed = "".join(secrets.choice(alphabet) for _ in range(16))

    # ID Google Sheet: lấy từ RosterData.gs cũ hoặc biến môi trường FW_SHEET_ID (không ghi cứng vào mã nguồn công khai)
    sheet_id = os.environ.get("FW_SHEET_ID", "")
    if not sheet_id and os.path.exists(OUT):
        m = re.search(r"var SHEET_ID = '([A-Za-z0-9_-]+)'", open(OUT, encoding="utf-8").read())
        sheet_id = m.group(1) if m else ""
    if not sheet_id:
        raise SystemExit("Thiếu ID Google Sheet: đặt biến môi trường FW_SHEET_ID rồi chạy lại.")

    rows = df[FIELDS].values.tolist()
    lines = [
        "// TỰ SINH bởi prepare_roster.py – KHÔNG chỉnh tay, KHÔNG commit (có dữ liệu cá nhân).",
        "var ROSTER_FIELDS = " + json.dumps(FIELDS, ensure_ascii=False) + ";",
        "var SHEET_ID = '" + sheet_id + "';",
        "var ADMIN_KEY_SEED = '" + seed + "';",
        "var ROSTER_DATA = [",
    ]
    lines += ["  " + json.dumps(r, ensure_ascii=False) + "," for r in rows]
    lines.append("];")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    print(f"\nĐã ghi {len(rows)} dòng -> {OUT} ({os.path.getsize(OUT):,} bytes)")


if __name__ == "__main__":
    main()
