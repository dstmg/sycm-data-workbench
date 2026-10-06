from __future__ import annotations

import argparse
import json
import math
import statistics
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NORMALIZED_PATH = ROOT / "normalized" / "homepage-core-data.json"

METRICS = {
    "payment_amount": {"position": 1, "label": "支付金额", "format": "currency", "aggregate": "sum"},
    "payment_buyers": {"position": 4, "label": "支付买家数", "format": "integer", "aggregate": "mean"},
    "conversion_rate": {"position": 5, "label": "支付转化率", "format": "percent", "aggregate": "mean"},
    "average_order_value": {"position": 6, "label": "客单价", "format": "currency", "aggregate": "mean"},
    "visitors": {"position": 12, "label": "访客数", "format": "integer", "aggregate": "mean"},
    "refund_amount": {"position": 14, "label": "成功退款金额", "format": "currency", "aggregate": "sum"},
    "net_payment_amount": {"position": 19, "label": "净支付金额", "format": "currency", "aggregate": "sum"},
    "add_cart_people": {"position": 21, "label": "加购人数", "format": "integer", "aggregate": "mean"},
}


def metric_id(position: int) -> str:
    return f"metric_{position:02d}"


def metric_value(record: dict, key: str, variant: str = "self") -> float | int | None:
    cell = record["metrics"][metric_id(METRICS[key]["position"])][variant]
    return cell["value"]


def aggregate(records: list[dict], key: str, variant: str = "self", force: str | None = None) -> float | None:
    values = [metric_value(record, key, variant) for record in records]
    values = [float(value) for value in values if value is not None]
    if not values:
        return None
    method = force or METRICS[key]["aggregate"]
    return sum(values) if method == "sum" else sum(values) / len(values)


def safe_change(current: float | None, previous: float | None) -> float | None:
    if current is None or previous in {None, 0}:
        return None
    return current / previous - 1


def format_value(value: float | None, format_name: str) -> str:
    if value is None:
        return "暂无"
    if format_name == "currency":
        return f"¥{value:,.2f}"
    if format_name == "percent":
        return f"{value * 100:.2f}%"
    if format_name == "integer":
        return f"{round(value):,}"
    return f"{value:,.2f}"


def format_change(value: float | None) -> str:
    if value is None:
        return "暂无可比"
    return f"{'+' if value > 0 else ''}{value * 100:.1f}%"


def severity(value: float | None) -> str:
    if value is None:
        return "neutral"
    if value <= -0.15:
        return "critical"
    if value <= -0.05:
        return "warning"
    if value >= 0.08:
        return "positive"
    return "neutral"


def worst_severity(*values: str) -> str:
    order = {"critical": 0, "warning": 1, "neutral": 2, "positive": 3}
    return min(values, key=lambda item: order[item])


def parse_date(value: str) -> date:
    return datetime.strptime(value, "%Y-%m-%d").date()


def period_source(records: list[dict], key: str, day_count: int) -> dict:
    first = records[0]
    last = records[-1]
    cell = last["metrics"][metric_id(METRICS[key]["position"])]["self"]
    return {
        **cell["source"],
        "date_from": first["date"],
        "date_to": last["date"],
        "raw": cell["raw"] if day_count == 1 else None,
        "caliber": (
            "单日生意参谋导出值（本店）"
            if day_count == 1
            else "基于每日导出值计算；金额求和，人数、比例与客单价按日均展示"
        ),
    }


def kpi(records: list[dict], previous: list[dict], key: str) -> dict:
    meta = METRICS[key]
    current = aggregate(records, key)
    prior = aggregate(previous, key) if previous else None
    peer_average = aggregate(records, key, "peer_average")
    peer_excellent = aggregate(records, key, "peer_excellent")
    return {
        "key": key,
        "label": meta["label"],
        "position": meta["position"],
        "value": current,
        "value_label": format_value(current, meta["format"]),
        "format": meta["format"],
        "comparison_change": safe_change(current, prior),
        "comparison_change_label": format_change(safe_change(current, prior)),
        "peer_average": peer_average,
        "peer_average_label": format_value(peer_average, meta["format"]),
        "peer_excellent": peer_excellent,
        "peer_excellent_label": format_value(peer_excellent, meta["format"]),
        "peer_gap": safe_change(current, peer_average),
        "source": period_source(records, key, len(records)),
    }


def anomaly_indexes(values: list[float | None]) -> list[int]:
    present = [value for value in values if value is not None]
    if len(present) < 7:
        return []
    median = statistics.median(present)
    deviations = [abs(value - median) for value in present]
    mad = statistics.median(deviations)
    if mad == 0:
        return [index for index, value in enumerate(values) if value is not None and median and abs(value / median - 1) >= 0.5]
    threshold = 3 * 1.4826 * mad
    return [index for index, value in enumerate(values) if value is not None and abs(value - median) > threshold]


def build_period_analysis(normalized: dict, date_from: str | None, date_to: str | None) -> dict:
    all_records = normalized["daily"]
    available_from = all_records[0]["date"]
    available_to = all_records[-1]["date"]
    date_to = date_to or available_to
    date_from = date_from or date_to

    start = parse_date(date_from)
    end = parse_date(date_to)
    minimum = parse_date(available_from)
    maximum = parse_date(available_to)
    if start > end:
        raise ValueError("开始日期不能晚于结束日期")
    if start < minimum or end > maximum:
        raise ValueError(f"日期必须位于 {available_from} 至 {available_to}")

    selected = [record for record in all_records if date_from <= record["date"] <= date_to]
    expected_days = (end - start).days + 1
    if len(selected) != expected_days:
        raise ValueError("所选日期范围存在缺失日，无法生成连续周期诊断")

    previous_end = start - timedelta(days=1)
    previous_start = previous_end - timedelta(days=expected_days - 1)
    previous = [
        record
        for record in all_records
        if previous_start.isoformat() <= record["date"] <= previous_end.isoformat()
    ]
    comparison_complete = len(previous) == expected_days

    kpis = [
        kpi(selected, previous if comparison_complete else [], "net_payment_amount"),
        kpi(selected, previous if comparison_complete else [], "visitors"),
        kpi(selected, previous if comparison_complete else [], "conversion_rate"),
        kpi(selected, previous if comparison_complete else [], "average_order_value"),
    ]
    by_key = {item["key"]: item for item in kpis}

    payment_amount = aggregate(selected, "payment_amount")
    refund_amount = aggregate(selected, "refund_amount")
    by_key["net_payment_amount"]["supporting"] = [
        {"label": "支付金额", "value": payment_amount, "value_label": format_value(payment_amount, "currency")},
        {"label": "成功退款", "value": refund_amount, "value_label": format_value(refund_amount, "currency")},
    ]

    visitor_average = aggregate(selected, "visitors")
    add_cart_average = aggregate(selected, "add_cart_people")
    buyer_average = aggregate(selected, "payment_buyers")
    visit_to_cart = add_cart_average / visitor_average if visitor_average else None
    cart_to_buyer = buyer_average / add_cart_average if add_cart_average else None
    visit_to_buyer = buyer_average / visitor_average if visitor_average else None

    conversion = by_key["conversion_rate"]
    visitors = by_key["visitors"]
    order_value = by_key["average_order_value"]
    visitor_days = aggregate(selected, "visitors", force="sum") or 0
    conversion_gap = max(0.0, (conversion["peer_average"] or 0) - (conversion["value"] or 0))
    buyer_impact = visitor_days * conversion_gap
    amount_impact = buyer_impact * (order_value["value"] or 0)

    benchmark = [
        {
            "key": item["key"],
            "label": item["label"],
            "format": item["format"],
            "self": item["value"],
            "self_label": item["value_label"],
            "peer_average": item["peer_average"],
            "peer_average_label": item["peer_average_label"],
            "peer_excellent": item["peer_excellent"],
            "peer_excellent_label": item["peer_excellent_label"],
        }
        for item in kpis
    ]

    drivers = []
    for key in ("visitors", "conversion_rate", "average_order_value"):
        current = aggregate(selected, key)
        prior = aggregate(previous, key) if comparison_complete else None
        value = safe_change(current, prior)
        drivers.append(
            {
                "key": key,
                "label": METRICS[key]["label"],
                "comparison_change": value,
                "comparison_change_label": format_change(value),
            }
        )
    ranked_drivers = sorted(
        drivers,
        key=lambda item: item["comparison_change"] if item["comparison_change"] is not None else math.inf,
    )
    primary_driver = ranked_drivers[0]

    focus = []
    if visitors["peer_gap"] is not None and visitors["peer_gap"] >= 0 and conversion["peer_gap"] is not None and conversion["peer_gap"] < 0:
        focus.append(
            {
                "title": "流量规模高于同行，但转化效率偏低",
                "verdict": "当前主要矛盾不是流量总量，而是流量进入后的商品承接与成交效率。",
                "evidence": [
                    f"日均访客 {visitors['value_label']}，较同行平均 {format_change(visitors['peer_gap'])}",
                    f"日均支付转化率 {conversion['value_label']}，较同行平均 {format_change(conversion['peer_gap'])}",
                    f"静态影响估算：约 {buyer_impact:,.0f} 个买家人次、{format_value(amount_impact, 'currency')} 支付金额空间",
                ],
                "severity": "critical",
                "source": conversion["source"],
            }
        )

    revenue = by_key["net_payment_amount"]
    focus.append(
        {
            "title": f"净支付金额较上一周期 {revenue['comparison_change_label']}",
            "verdict": "结果指标按所选周期与紧邻的等长上一周期比较。",
            "evidence": [
                f"本周期净支付金额 {revenue['value_label']}",
                f"支付金额 {format_value(payment_amount, 'currency')}，成功退款 {format_value(refund_amount, 'currency')}",
            ],
            "severity": severity(revenue["comparison_change"]),
            "source": revenue["source"],
        }
    )

    if primary_driver["comparison_change"] is not None:
        source_key = primary_driver["key"]
        focus.append(
            {
                "title": f"主要关联项：{primary_driver['label']} {primary_driver['comparison_change_label']}",
                "verdict": "这是经营链路的关联分解，不代表因果，需要商品和流量模块继续验证。",
                "evidence": [
                    "经营链路按 访客数 × 支付转化率 × 客单价 检查",
                    "当前首页汇总无法直接定位到渠道、商品或关键词",
                ],
                "severity": severity(primary_driver["comparison_change"]),
                "source": period_source(selected, source_key, len(selected)),
            }
        )

    focus = sorted(
        focus[:3],
        key=lambda item: {"critical": 0, "warning": 1, "neutral": 2, "positive": 3}[item["severity"]],
    )

    actions = []
    if conversion["peer_gap"] is not None and conversion["peer_gap"] < 0:
        actions.append(
            {
                "title": "检查低转化流量与商品承接",
                "reason": f"转化率较同行平均 {format_change(conversion['peer_gap'])}，首页只能确认效率差距，不能判断具体渠道或商品。",
                "priority": "高",
                "status": "待处理",
                "target_module": "03-流量 / 05-商品",
            }
        )
    if revenue["comparison_change"] is not None and revenue["comparison_change"] < -0.05:
        actions.append(
            {
                "title": "复核所选周期收入下降",
                "reason": f"净支付金额较等长上一周期 {revenue['comparison_change_label']}，核对活动、价格和投放变更记录。",
                "priority": "高",
                "status": "待处理",
                "target_module": "行动追踪",
            }
        )
    else:
        actions.append(
            {
                "title": "验证转化提升空间",
                "reason": f"按当前流量与客单价静态估算，转化率达到同行平均对应约 {format_value(amount_impact, 'currency')} 支付金额空间。",
                "priority": "中",
                "status": "待验证",
                "target_module": "经营诊断",
            }
        )
    actions.append(
        {
            "title": "配置店铺标识",
            "reason": "源文件不含店铺 ID 或店铺名；多店分析前需要配置 shop_code。",
            "priority": "中",
            "status": "待配置",
            "target_module": "系统状态",
        }
    )

    if len(selected) == 1:
        selected_index = all_records.index(selected[-1])
        trend_records = all_records[max(0, selected_index - 29) : selected_index + 1]
        trend_label = "截至所选日期的最近 30 天"
    else:
        trend_records = selected[-60:]
        trend_label = "所选周期每日趋势" if len(selected) <= 60 else "所选周期最近 60 天"
    trend_values = [metric_value(record, "net_payment_amount") for record in trend_records]

    comparison_label = (
        f"对比 {previous_start.isoformat()} 至 {previous_end.isoformat()}"
        if comparison_complete
        else "缺少完整上一周期"
    )
    caliber = (
        "单日真实导出值"
        if len(selected) == 1
        else "基于每日导出数据计算：金额求和，人数、比例与客单价按日均"
    )

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "status": "ready",
        "latest_date": available_to,
        "selection": {
            "date_from": date_from,
            "date_to": date_to,
            "day_count": len(selected),
            "available_from": available_from,
            "available_to": available_to,
            "caliber": caliber,
            "comparison_complete": comparison_complete,
            "comparison_from": previous_start.isoformat(),
            "comparison_to": previous_end.isoformat(),
            "comparison_label": comparison_label,
        },
        "coverage": normalized["quality"],
        "kpis": kpis,
        "focus": focus,
        "actions": actions[:3],
        "drivers": drivers,
        "benchmark": benchmark,
        "funnel": {
            "caliber": "单日真实人数" if len(selected) == 1 else "每日人数均值",
            "stages": [
                {"key": "visitors", "label": "访客", "value": visitor_average, "value_label": format_value(visitor_average, "integer")},
                {"key": "add_cart_people", "label": "加购人数", "value": add_cart_average, "value_label": format_value(add_cart_average, "integer")},
                {"key": "payment_buyers", "label": "支付买家", "value": buyer_average, "value_label": format_value(buyer_average, "integer")},
            ],
            "rates": [
                {"label": "访客到加购", "value": visit_to_cart, "value_label": format_value(visit_to_cart, "percent")},
                {"label": "加购到支付", "value": cart_to_buyer, "value_label": format_value(cart_to_buyer, "percent")},
                {"label": "访客到支付", "value": visit_to_buyer, "value_label": format_value(visit_to_buyer, "percent")},
            ],
            "impact": {
                "buyer_count": buyer_impact,
                "buyer_count_label": f"{buyer_impact:,.0f}",
                "amount": amount_impact,
                "amount_label": format_value(amount_impact, "currency"),
                "description": "按同行平均转化率、当前流量与客单价静态估算，不代表业绩承诺",
            },
        },
        "trend": {
            "labels": [record["date"] for record in trend_records],
            "series": {"net_payment_amount": trend_values},
            "anomaly_indexes": anomaly_indexes(trend_values),
            "label": trend_label,
        },
        "sources": normalized["sources"],
        "method": {
            "comparison": "所选周期与紧邻的等长上一周期比较",
            "driver_chain": "净支付金额关联检查：访客数 × 支付转化率 × 客单价，并结合退款",
            "missing_values": "保留为 null，不补 0",
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--from", dest="date_from")
    parser.add_argument("--to", dest="date_to")
    args = parser.parse_args()
    normalized = json.loads(NORMALIZED_PATH.read_text(encoding="utf-8"))
    result = build_period_analysis(normalized, args.date_from, args.date_to)
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
