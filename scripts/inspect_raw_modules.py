from __future__ import annotations

import hashlib
import io
import json
import re
import sys
import zipfile
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree as ET

from inspect_xlsx import MAIN_NS, NS, cell_value, column_index, shared_strings, workbook_sheets


ROOT = Path(__file__).resolve().parents[1]
RAW_ROOT = ROOT / "raw"
OUTPUT = ROOT / "audit" / "raw-modules-inventory.json"
MODULES = ("02-交易", "03-流量", "04-客户")


def recover_zip_name(name: str) -> str:
    try:
        return name.encode("cp437").decode("gbk")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return name


def read_sheet_rows(archive: zipfile.ZipFile, path: str, strings: list[str], limit: int = 5) -> tuple[str | None, int, list[list[object]]]:
    root = ET.fromstring(archive.read(path))
    dimension = root.find("m:dimension", NS)
    rows = root.findall("m:sheetData/m:row", NS)
    values_out = []
    for row in rows[:limit]:
        values = {}
        for cell in row.findall(f"{{{MAIN_NS}}}c"):
            column = column_index(cell.attrib.get("r", ""))
            if column:
                values[column] = cell_value(cell, strings)
        values_out.append([values.get(index, "") for index in range(1, max(values, default=0) + 1)])
    return (dimension.attrib.get("ref") if dimension is not None else None, len(rows), values_out)


def inspect_workbook(data: bytes, member_name: str) -> dict:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        strings = shared_strings(archive)
        sheets = []
        for name, path in workbook_sheets(archive):
            dimension, row_count, rows = read_sheet_rows(archive, path, strings)
            headers = rows[0] if rows else []
            signature = hashlib.sha256(json.dumps(headers, ensure_ascii=False).encode("utf-8")).hexdigest()
            sheets.append(
                {
                    "name": name,
                    "dimension": dimension,
                    "row_count": row_count,
                    "column_count": len(headers),
                    "header_signature": signature,
                    "headers": headers,
                    "sample_rows": rows[1:3],
                }
            )
    return {"name": member_name, "sheets": sheets}


def date_tokens(name: str) -> list[str]:
    return re.findall(r"20\d{2}-\d{2}-\d{2}", name)


def scan_module(module: str) -> dict:
    archives = []
    module_dir = RAW_ROOT / module
    for archive_path in sorted(module_dir.glob("*.zip")):
        workbooks = []
        with zipfile.ZipFile(archive_path) as outer:
            for member in outer.infolist():
                if member.is_dir() or not member.filename.lower().endswith(".xlsx"):
                    continue
                member_name = recover_zip_name(member.filename)
                workbooks.append(inspect_workbook(outer.read(member), member_name))
        all_sheets = [sheet for workbook in workbooks for sheet in workbook["sheets"]]
        archives.append(
            {
                "name": archive_path.name,
                "size": archive_path.stat().st_size,
                "workbook_count": len(workbooks),
                "sheet_names": dict(Counter(sheet["name"] for sheet in all_sheets)),
                "header_signatures": dict(Counter(sheet["header_signature"] for sheet in all_sheets)),
                "dimensions": dict(Counter(str(sheet["dimension"]) for sheet in all_sheets)),
                "date_tokens": sorted({token for workbook in workbooks for token in date_tokens(workbook["name"])}),
                "workbooks": workbooks,
            }
        )
    return {"archive_count": len(archives), "archives": archives}


def main() -> None:
    payload = {module: scan_module(module) for module in MODULES}
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    print(
        json.dumps(
            {
                module: {
                    "archives": data["archive_count"],
                    "workbooks": sum(item["workbook_count"] for item in data["archives"]),
                }
                for module, data in payload.items()
            },
            ensure_ascii=True,
        )
    )


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
