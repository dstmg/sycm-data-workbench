from __future__ import annotations

import hashlib
import io
import json
import math
import re
import zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

from inspect_xlsx import MAIN_NS, NS, cell_value, column_index, shared_strings, workbook_sheets


ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "raw" / "01-首页"
NORMALIZED_PATH = ROOT / "normalized" / "homepage-data.json"
CORE_PATH = ROOT / "normalized" / "homepage-core-data.json"
SUMMARY_PATH = ROOT / "reports" / "homepage-summary.json"

CORE_METRICS = {
    "payment_amount": 1,
    "payment_buyers": 4,
    "conversion_rate": 5,
    "average_order_value": 6,
    "repeat_purchase_rate": 7,
    "visitors": 12,
    "refund_amount": 14,
    "signed_refund_rate": 15,
    "net_payment_amount": 19,
}

FORMAT_BY_POSITION = {
    1: "currency",
    4: "integer",
    5: "percent",
    6: "currency",
    7: "percent",
    12: "integer",
    14: "currency",
    15: "percent",
    19: "currency",
}


def recover_zip_name(name: str) -> str:
    try:
        return name.encode("cp437").decode("gbk")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return name


def source_fingerprint(paths: list[Path]) -> str:
    digest = hashlib.sha256()
    for path in paths:
        stat = path.stat()
        digest.update(path.name.encode("utf-8"))
        digest.update(str(stat.st_size).encode("ascii"))
        digest.update(str(stat.st_mtime_ns).encode("ascii"))
    return digest.hexdigest()


def write_json(path: Path, payload: dict) -> None:
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    temporary.replace(path)


def read_rows(workbook_bytes: bytes) -> tuple[str, list[list[object]]]:
    with zipfile.ZipFile(io.BytesIO(workbook_bytes)) as archive:
        strings = shared_strings(archive)
        sheets = workbook_sheets(archive)
        if not sheets:
            return "", []
        sheet_name, sheet_path = sheets[0]
        root = ET.fromstring(archive.read(sheet_path))
        rows: list[list[object]] = []
        for row in root.findall("m:sheetData/m:row", NS):
            values: dict[int, object] = {}
            for cell in row.findall(f"{{{MAIN_NS}}}c"):
                col = column_index(cell.attrib.get("r", ""))
                if col:
                    values[col] = cell_value(cell, strings)
            if values:
                rows.append([values.get(index, "") for index in range(1, max(values) + 1)])
        return sheet_name, rows


def parse_export_time(name: str) -> str | None:
    match = re.search(r"-(\d{8}_\d{6})\.xlsx$", name, re.IGNORECASE)
    if not match:
        return None
    try:
        return datetime.strptime(match.group(1), "%Y%m%d_%H%M%S").isoformat(sep=" ")
    except ValueError:
        return None


def parse_value(value: object) -> float | int | None:
    if value in {"", None, "-", "--"}:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return value if math.isfinite(float(value)) else None
    text = str(value).strip().replace(",", "")
    percent = text.endswith("%")
    if percent:
        text = text[:-1]
    try:
        number = float(text)
    except ValueError:
        return None
    return number / 100 if percent else number


def clean_metric_name(header: str) -> str:
    result = str(header)
    for suffix in ("（本店）", "(本店)", "环比", "（同行同层平均）", "（同行同层优秀）"):
        result = result.replace(suffix, "")
    return result.strip()


def metric_id(position: int) -> str:
    return f"metric_{position:02d}"


def provenance(
    archive_name: str,
    workbook_name: str,
    sheet_name: str,
    column: int,
    header: str,
) -> dict[str, object]:
    return {
        "archive_file": archive_name,
        "workbook_file": workbook_name,
        "sheet": sheet_name,
        "column": column,
        "header": header,
    }


def metric_cell(raw: object, source: dict[str, object]) -> dict[str, object]:
    return {"raw": raw if raw not in {""} else None, "value": parse_value(raw), "source": source}


def parse_daily(
    archive_name: str,
    workbook_name: str,
    sheet_name: str,
    headers: list[object],
    values: list[object],
) -> dict[str, object]:
    metrics = {}
    metric_count = max(0, (len(headers) - 6) // 4)
    for offset in range(metric_count):
        position = offset + 1
        start = 6 + offset * 4
        variants = ("self", "mom", "peer_average", "peer_excellent")
        metric = {}
        for variant_offset, variant in enumerate(variants):
            index = start + variant_offset
            header = str(headers[index]) if index < len(headers) else ""
            raw = values[index] if index < len(values) else ""
            metric[variant] = metric_cell(
                raw,
                provenance(archive_name, workbook_name, sheet_name, index + 1, header),
            )
        metrics[metric_id(position)] = metric

    date_range = str(values[4]) if len(values) > 4 else ""
    statistic_date = date_range.split("|", 1)[0] if date_range else None
    return {
        "date": statistic_date,
        "date_range": date_range or None,
        "export_time": values[5] if len(values) > 5 and values[5] != "" else parse_export_time(workbook_name),
        "shop_code": None,
        "source": {"archive_file": archive_name, "workbook_file": workbook_name, "sheet": sheet_name},
        "metrics": metrics,
    }


def parse_monthly_rows(
    archive_name: str,
    workbook_name: str,
    sheet_name: str,
    headers: list[object],
    rows: list[list[object]],
) -> list[dict[str, object]]:
    records = []
    export_time = parse_export_time(workbook_name)
    metric_count = max(0, (len(headers) - 2) // 2)
    for values in rows:
        if not values:
            continue
        metrics = {}
        for offset in range(metric_count):
            position = offset + 1
            start = 2 + offset * 2
            metric = {}
            for variant_offset, variant in enumerate(("self", "mom")):
                index = start + variant_offset
                header = str(headers[index]) if index < len(headers) else ""
                raw = values[index] if index < len(values) else ""
                metric[variant] = metric_cell(
                    raw,
                    provenance(archive_name, workbook_name, sheet_name, index + 1, header),
                )
            metrics[metric_id(position)] = metric
        records.append(
            {
                "date": str(values[0]) if values[0] != "" else None,
                "date_range": str(values[1]) if len(values) > 1 and values[1] != "" else None,
                "export_time": export_time,
                "shop_code": None,
                "source": {"archive_file": archive_name, "workbook_file": workbook_name, "sheet": sheet_name},
                "metrics": metrics,
            }
        )
    return records


def build_dictionary(daily_headers: list[object], monthly_headers: list[object]) -> list[dict[str, object]]:
    names = [clean_metric_name(str(daily_headers[6 + offset * 4])) for offset in range(54)]
    duplicates = Counter(names)
    result = []
    for offset, name in enumerate(names):
        position = offset + 1
        display_name = f"{name}（位置{position}）" if duplicates[name] > 1 else name
        result.append(
            {
                "id": metric_id(position),
                "position": position,
                "name": name,
                "display_name": display_name,
                "format": FORMAT_BY_POSITION.get(position, "number"),
                "daily_columns": [7 + offset * 4 + index for index in range(4)],
                "daily_headers": [str(value) for value in daily_headers[6 + offset * 4 : 10 + offset * 4]],
                "monthly_columns": [3 + offset * 2 + index for index in range(2)],
                "monthly_headers": [str(value) for value in monthly_headers[2 + offset * 2 : 4 + offset * 2]],
                "duplicate_name": duplicates[name] > 1,
            }
        )
    return result


def mean(values: list[float | int | None]) -> float | None:
    present = [float(value) for value in values if value is not None]
    return sum(present) / len(present) if present else None


def change(current: float | int | None, previous: float | int | None) -> float | None:
    if current is None or previous in {None, 0}:
        return None
    return float(current) / float(previous) - 1


def metric_value(record: dict[str, object], position: int, variant: str = "self") -> float | int | None:
    return record["metrics"][metric_id(position)][variant]["value"]


def metric_window(records: list[dict[str, object]], position: int, start: int, end: int) -> float | None:
    return mean([metric_value(record, position) for record in records[start:end]])


def format_value(value: float | int | None, format_name: str) -> str:
    if value is None:
        return "暂无"
    if format_name == "currency":
        return f"¥{float(value):,.2f}"
    if format_name == "percent":
        return f"{float(value) * 100:.2f}%"
    if format_name == "integer":
        return f"{int(round(float(value))):,}"
    return f"{float(value):,.2f}"


def format_change(value: float | None) -> str:
    if value is None:
        return "暂无可比"
    sign = "+" if value > 0 else ""
    return f"{sign}{value * 100:.1f}%"


def severity_for(value: float | None, negative_is_bad: bool = False) -> str:
    if value is None:
        return "neutral"
    adjusted = -value if negative_is_bad else value
    if adjusted <= -0.15:
        return "critical"
    if adjusted <= -0.05:
        return "warning"
    if adjusted >= 0.08:
        return "positive"
    return "neutral"


def worst_severity(*values: str) -> str:
    order = {"critical": 0, "warning": 1, "neutral": 2, "positive": 3}
    return min(values, key=lambda value: order[value])


def source_summary(record: dict[str, object], position: int) -> dict[str, object]:
    cell = record["metrics"][metric_id(position)]["self"]
    return {
        **cell["source"],
        "date": record["date"],
        "raw": cell["raw"],
        "caliber": "生意参谋导出值（本店）；周对比由最近7日均值与前7日均值计算",
    }


def kpi_payload(records: list[dict[str, object]], key: str, label: str, position: int) -> dict[str, object]:
    latest = records[-1]
    current = metric_value(latest, position)
    prior = metric_value(records[-2], position) if len(records) > 1 else None
    recent_7 = metric_window(records, position, max(0, len(records) - 7), len(records))
    previous_7 = metric_window(records, position, max(0, len(records) - 14), max(0, len(records) - 7))
    peer = metric_value(latest, position, "peer_average")
    return {
        "key": key,
        "label": label,
        "position": position,
        "value": current,
        "value_label": format_value(current, FORMAT_BY_POSITION[position]),
        "format": FORMAT_BY_POSITION[position],
        "day_change": change(current, prior),
        "day_change_label": format_change(change(current, prior)),
        "week_change": change(recent_7, previous_7),
        "week_change_label": format_change(change(recent_7, previous_7)),
        "peer_average": peer,
        "peer_gap": change(current, peer),
        "source": source_summary(latest, position),
    }


def focus_item(
    title: str,
    verdict: str,
    evidence: list[str],
    severity: str,
    position: int,
    latest: dict[str, object],
) -> dict[str, object]:
    return {
        "title": title,
        "verdict": verdict,
        "evidence": evidence,
        "severity": severity,
        "source": source_summary(latest, position),
    }


def build_analysis(normalized: dict[str, object]) -> dict[str, object]:
    records = normalized["daily"]
    latest = records[-1]
    kpis = [
        kpi_payload(records, "payment_amount", "支付金额", 1),
        kpi_payload(records, "visitors", "访客数", 12),
        kpi_payload(records, "conversion_rate", "支付转化率", 5),
        kpi_payload(records, "average_order_value", "客单价", 6),
    ]
    by_key = {item["key"]: item for item in kpis}

    revenue = by_key["payment_amount"]
    revenue_focus = focus_item(
        f"支付金额周趋势{format_change(revenue['week_change'])}",
        "最近 7 日均值与前 7 日相比，系统先判断结果指标是否偏离。",
        [
            f"{latest['date']} 支付金额 {revenue['value_label']}，较前一日 {revenue['day_change_label']}",
            f"较同行同层平均 {format_change(revenue['peer_gap'])}",
        ],
        severity_for(revenue["week_change"]),
        1,
        latest,
    )

    conversion = by_key["conversion_rate"]
    conversion_focus = focus_item(
        f"支付转化率周趋势{format_change(conversion['week_change'])}",
        "转化率是支付金额链路中的核心效率指标，低于同行时应继续下钻商品和流量来源。",
        [
            f"{latest['date']} 支付转化率 {conversion['value_label']}，较前一日 {conversion['day_change_label']}",
            f"较同行同层平均 {format_change(conversion['peer_gap'])}",
        ],
        worst_severity(
            severity_for(conversion["week_change"]),
            severity_for(conversion["peer_gap"]),
            severity_for(conversion["day_change"]),
        ),
        5,
        latest,
    )

    drivers = []
    for key in ("visitors", "conversion_rate", "average_order_value"):
        item = by_key[key]
        drivers.append(
            {
                "key": key,
                "label": item["label"],
                "week_change": item["week_change"],
                "week_change_label": item["week_change_label"],
            }
        )
    ranked_drivers = sorted(drivers, key=lambda item: item["week_change"] if item["week_change"] is not None else 999)
    primary_driver = ranked_drivers[0]
    driver_position = CORE_METRICS[primary_driver["key"]]
    driver_focus = focus_item(
        f"主要关联项：{primary_driver['label']} {primary_driver['week_change_label']}",
        "这是支付金额变化的关联分解，不代表因果；需要对应模块数据继续验证。",
        [
            "经营链路按 访客数 × 支付转化率 × 客单价 检查",
            "当前只有首页汇总，尚不能定位到渠道、商品或关键词",
        ],
        severity_for(primary_driver["week_change"]),
        driver_position,
        latest,
    )

    focus = sorted(
        [revenue_focus, conversion_focus, driver_focus],
        key=lambda item: {"critical": 0, "warning": 1, "neutral": 2, "positive": 3}[item["severity"]],
    )

    actions = []
    if conversion["peer_gap"] is not None and conversion["peer_gap"] < 0:
        actions.append(
            {
                "title": "补齐商品效果与流量来源数据",
                "reason": f"支付转化率较同行同层平均 {format_change(conversion['peer_gap'])}，首页只能确认差距，不能定位原因。",
                "priority": "高",
                "target_module": "03-流量 / 05-商品",
            }
        )
    if primary_driver["week_change"] is not None and primary_driver["week_change"] < -0.05:
        actions.append(
            {
                "title": f"复核{primary_driver['label']}连续变化",
                "reason": f"最近 7 日均值较前 7 日 {primary_driver['week_change_label']}，先核对活动、价格和投放变更记录。",
                "priority": "高",
                "target_module": "行动追踪",
            }
        )
    actions.append(
        {
            "title": "配置店铺标识",
            "reason": "当前导出文件不含店铺 ID 或店铺名；正式多店分析前需要配置 shop_code。",
            "priority": "中",
            "target_module": "系统状态",
        }
    )
    actions = actions[:3]

    trend_records = records[-30:]
    trend_series = {}
    for key, position in CORE_METRICS.items():
        if key not in {"payment_amount", "visitors", "conversion_rate", "average_order_value"}:
            continue
        trend_series[key] = [metric_value(record, position) for record in trend_records]

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "status": "ready",
        "latest_date": latest["date"],
        "coverage": normalized["quality"],
        "kpis": kpis,
        "focus": focus,
        "actions": actions,
        "drivers": drivers,
        "trend": {"labels": [record["date"] for record in trend_records], "series": trend_series},
        "sources": normalized["sources"],
        "method": {
            "comparison": "最近7个自然日均值 vs 紧邻的前7个自然日均值",
            "driver_chain": "支付金额 ≈ 访客数 × 支付转化率 × 客单价；仅用于关联分解",
            "missing_values": "保留为 null，不补 0",
        },
    }


def main() -> None:
    archives = sorted(RAW_DIR.glob("*.zip"))
    if not archives:
        raise SystemExit("raw/01-首页 下未找到 ZIP 文件")

    daily: list[dict[str, object]] = []
    monthly_candidates: list[dict[str, object]] = []
    source_files = []
    daily_headers: list[object] | None = None
    monthly_headers: list[object] | None = None
    daily_signatures = Counter()
    monthly_signatures = Counter()

    for archive_path in archives:
        workbook_count = 0
        daily_count = 0
        monthly_count = 0
        with zipfile.ZipFile(archive_path) as outer:
            for member in outer.infolist():
                if member.is_dir() or not member.filename.lower().endswith(".xlsx"):
                    continue
                workbook_count += 1
                workbook_name = recover_zip_name(member.filename)
                sheet_name, rows = read_rows(outer.read(member))
                if len(rows) < 2:
                    continue
                headers = rows[0]
                signature = hashlib.sha256(json.dumps(headers, ensure_ascii=False).encode("utf-8")).hexdigest()
                if sheet_name == "数据概览":
                    daily_count += 1
                    daily_headers = daily_headers or headers
                    daily_signatures[signature] += 1
                    daily.append(parse_daily(archive_path.name, workbook_name, sheet_name, headers, rows[1]))
                elif sheet_name == "数据看板":
                    monthly_count += 1
                    monthly_headers = monthly_headers or headers
                    monthly_signatures[signature] += 1
                    monthly_candidates.extend(
                        parse_monthly_rows(archive_path.name, workbook_name, sheet_name, headers, rows[1:])
                    )
        source_files.append(
            {
                "name": archive_path.name,
                "size": archive_path.stat().st_size,
                "modified_at": datetime.fromtimestamp(archive_path.stat().st_mtime, timezone.utc).isoformat(),
                "workbook_count": workbook_count,
                "daily_workbooks": daily_count,
                "monthly_workbooks": monthly_count,
            }
        )

    if not daily or daily_headers is None or monthly_headers is None:
        raise SystemExit("ZIP 中未同时识别到首页数据概览和数据看板")

    daily_by_date = {}
    for record in daily:
        if record["date"]:
            daily_by_date[record["date"]] = record
    daily = [daily_by_date[key] for key in sorted(daily_by_date)]

    monthly_by_date = {}
    monthly_source_counts = Counter()
    for record in monthly_candidates:
        if not record["date"]:
            continue
        monthly_source_counts[record["date"]] += 1
        existing = monthly_by_date.get(record["date"])
        if existing is None or (record["export_time"] or "") >= (existing["export_time"] or ""):
            monthly_by_date[record["date"]] = record
    monthly = [monthly_by_date[key] for key in sorted(monthly_by_date)]

    dictionary = build_dictionary(daily_headers, monthly_headers)
    normalized = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_fingerprint": source_fingerprint(archives),
        "shop": {"shop_code": None, "status": "unconfigured", "reason": "源文件未包含店铺 ID 或店铺名"},
        "sources": source_files,
        "metric_dictionary": dictionary,
        "daily": daily,
        "monthly": monthly,
        "quality": {
            "archive_count": len(archives),
            "workbook_count": sum(item["workbook_count"] for item in source_files),
            "daily_workbook_count": sum(item["daily_workbooks"] for item in source_files),
            "daily_unique_dates": len(daily),
            "daily_start": daily[0]["date"],
            "daily_end": daily[-1]["date"],
            "monthly_workbook_count": sum(item["monthly_workbooks"] for item in source_files),
            "monthly_candidate_records": len(monthly_candidates),
            "monthly_unique_dates": len(monthly),
            "monthly_start": monthly[0]["date"] if monthly else None,
            "monthly_end": monthly[-1]["date"] if monthly else None,
            "daily_header_signatures": len(daily_signatures),
            "monthly_header_signatures": len(monthly_signatures),
            "duplicate_metric_names": sorted({item["name"] for item in dictionary if item["duplicate_name"]}),
            "shop_configured": False,
        },
    }

    NORMALIZED_PATH.parent.mkdir(parents=True, exist_ok=True)
    SUMMARY_PATH.parent.mkdir(parents=True, exist_ok=True)
    write_json(NORMALIZED_PATH, normalized)
    core_positions = {1, 4, 5, 6, 12, 14, 19, 21}
    core = {
        "generated_at": normalized["generated_at"],
        "source_fingerprint": normalized["source_fingerprint"],
        "shop": normalized["shop"],
        "sources": normalized["sources"],
        "quality": normalized["quality"],
        "metric_dictionary": [
            item for item in normalized["metric_dictionary"] if item["position"] in core_positions
        ],
        "daily": [
            {
                **{key: value for key, value in record.items() if key != "metrics"},
                "metrics": {
                    key: value
                    for key, value in record["metrics"].items()
                    if int(key.split("_", 1)[1]) in core_positions
                },
            }
            for record in normalized["daily"]
        ],
    }
    write_json(CORE_PATH, core)
    summary = build_analysis(normalized)
    summary["source_fingerprint"] = normalized["source_fingerprint"]
    write_json(SUMMARY_PATH, summary)
    print(json.dumps({"normalized": str(NORMALIZED_PATH), "core": str(CORE_PATH), "summary": str(SUMMARY_PATH), "quality": normalized["quality"]}, ensure_ascii=True))


if __name__ == "__main__":
    main()
