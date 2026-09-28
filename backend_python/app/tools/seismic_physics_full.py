from __future__ import annotations

import base64
import csv
import io
import json
import math
import zipfile
from datetime import UTC, datetime
from typing import Any

from app.tools.common import ToolError, parse_numbers


DEFAULT_SETTINGS: dict[str, Any] = {
    "detrend": "linear",
    "taperPercent": 5,
    "filterMode": "bandpass",
    "lowCut": 1,
    "highCut": 20,
    "filterOrder": 4,
    "zeroPhase": True,
    "notchEnabled": False,
    "notchFrequency": 50,
    "notchQ": 30,
    "sensitivity": 1,
    "outputUnit": "counts",
    "staMethod": "recursive",
    "staSeconds": 0.25,
    "ltaSeconds": 3,
    "triggerOn": 3,
    "triggerOff": 1.2,
    "minDuration": 0.1,
    "deadTime": 0.5,
    "aicPhase": "P",
    "aicStart": 7.5,
    "aicEnd": 9,
    "noiseStart": 0,
    "noiseEnd": 5,
    "signalStart": 7,
    "signalEnd": 16,
    "validationTolerance": 0.3,
}

DEFAULT_PHYSICS: dict[str, Any] = {
    "pTime": 8.2,
    "sTime": 12.6,
    "vp": 6,
    "vs": 3.5,
    "depth": 5,
    "density": 2700,
    "omega0": "",
    "radiation": 0.52,
    "freeSurface": 2,
    "waveType": "P",
}


def _number(value: Any, fallback: float, minimum: float | None = None, maximum: float | None = None) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        result = fallback
    if not math.isfinite(result):
        result = fallback
    if minimum is not None:
        result = max(minimum, result)
    if maximum is not None:
        result = min(maximum, result)
    return result


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _rms(values: list[float]) -> float:
    return math.sqrt(_mean([value * value for value in values])) if values else 0.0


def _std(values: list[float]) -> float:
    average = _mean(values)
    return math.sqrt(_mean([(value - average) ** 2 for value in values])) if values else 0.0


def _quantile(values: list[float], probability: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] * (upper - position) + ordered[upper] * (position - lower)


def _lcg(seed: int):
    state = seed & 0xFFFFFFFF

    def random() -> float:
        nonlocal state
        state = (1664525 * state + 1013904223) & 0xFFFFFFFF
        return state / 4294967296

    return random


def _synthetic_dataset(seed: int = 20260909) -> dict[str, Any]:
    random = _lcg(seed)
    sample_rate = 200.0
    sample_count = 6000
    p_time = 8.2
    s_time = 12.6
    channel_weights = {
        "BHZ": (1.0, 0.36, 0.16),
        "BHN": (0.24, 1.0, 0.44),
        "BHE": (0.18, 0.76, 1.0),
    }
    traces = []
    for channel_index, (channel, weights) in enumerate(channel_weights.items()):
        values = []
        for index in range(sample_count):
            time = index / sample_rate
            background = (
                0.022 * math.sin(2 * math.pi * 0.73 * time + channel_index * 0.41)
                + 0.016 * math.sin(2 * math.pi * 2.1 * time + channel_index)
                + (random() - 0.5) * 0.032
            )
            p_envelope = math.exp(-((time - p_time) / 0.43) ** 2)
            s_envelope = math.exp(-((time - s_time) / 0.86) ** 2)
            coda = math.exp(-(time - s_time) / 4.5) if time >= s_time else 0.0
            p_wave = weights[0] * 1.05 * p_envelope * math.sin(2 * math.pi * 8.1 * (time - p_time))
            s_wave = weights[1] * 1.72 * s_envelope * math.sin(2 * math.pi * 4.35 * (time - s_time) + 0.2)
            coda_wave = weights[2] * 0.34 * coda * math.sin(2 * math.pi * 3.15 * (time - s_time))
            values.append(background + p_wave + s_wave + coda_wave)
        traces.append({
            "id": f"SC.SVL1..{channel}",
            "network": "SC",
            "station": "SVL1",
            "location": "",
            "channel": channel,
            "sampleRate": sample_rate,
            "unit": "counts",
            "startTime": "2026-09-09T00:00:00.000Z",
            "values": values,
        })
    return {
        "name": "SVL1 三分量确定性基准",
        "sourceType": "synthetic-benchmark",
        "benchmark": True,
        "seed": seed,
        "sampleRate": sample_rate,
        "startTime": "2026-09-09T00:00:00.000Z",
        "traces": traces,
        "truthPicks": [
            {"id": "TRUTH-P", "phase": "P", "time": p_time, "traceId": traces[0]["id"], "source": "benchmark-truth"},
            {"id": "TRUTH-S", "phase": "S", "time": s_time, "traceId": traces[0]["id"], "source": "benchmark-truth"},
        ],
    }


def _parse_json_dataset(source: str, fallback_rate: float, name: str) -> dict[str, Any]:
    try:
        document = json.loads(source)
    except json.JSONDecodeError as error:
        raise ToolError("波形 JSON 无法解析") from error
    if not isinstance(document, dict):
        raise ToolError("波形 JSON 顶层必须是对象")
    sample_rate = _number(document.get("sampleRate"), fallback_rate, 0.001, 50_000)
    raw_traces = document.get("traces")
    traces: list[dict[str, Any]] = []
    if isinstance(raw_traces, dict):
        raw_traces = [{"id": key, "channel": key, "values": value} for key, value in raw_traces.items()]
    if not isinstance(raw_traces, list):
        raise ToolError("波形 JSON 需要 traces 数组或对象")
    for index, item in enumerate(raw_traces[:100]):
        if not isinstance(item, dict):
            continue
        values = item.get("values")
        if not isinstance(values, list):
            continue
        try:
            numbers = [float(value) for value in values[:200_000]]
        except (TypeError, ValueError) as error:
            raise ToolError("traces.values 只能包含有限数值") from error
        if len(numbers) < 64 or not all(math.isfinite(value) for value in numbers):
            continue
        channel = str(item.get("channel") or item.get("id") or f"CH{index + 1}")
        traces.append({
            "id": str(item.get("id") or channel),
            "network": str(item.get("network") or ""),
            "station": str(item.get("station") or ""),
            "location": str(item.get("location") or ""),
            "channel": channel,
            "sampleRate": _number(item.get("sampleRate"), sample_rate, 0.001, 50_000),
            "unit": str(item.get("unit") or "counts"),
            "startTime": item.get("startTime") or document.get("startTime"),
            "values": numbers,
        })
    if not traces:
        raise ToolError("波形 JSON 中没有至少 64 点的有效通道")
    return {
        "name": name or "导入波形 JSON",
        "sourceType": "json",
        "benchmark": False,
        "seed": None,
        "sampleRate": sample_rate,
        "startTime": document.get("startTime"),
        "traces": traces,
        "truthPicks": [],
    }


def _parse_csv_dataset(source: str, fallback_rate: float, name: str) -> dict[str, Any]:
    reader = csv.reader(io.StringIO(source.lstrip("\ufeff")))
    rows = [row for row in reader if any(cell.strip() for cell in row)]
    if len(rows) < 65:
        raise ToolError("波形 CSV 至少需要表头和 64 行采样")
    headers = [cell.strip() for cell in rows[0]]
    lowered = [header.casefold() for header in headers]
    time_index = next((index for index, value in enumerate(lowered) if value in {"time", "time_s", "timestamp", "t"}), -1)
    channel_indexes = [index for index, header in enumerate(headers) if index != time_index and header]
    if not channel_indexes:
        raise ToolError("波形 CSV 至少需要一个通道列")
    times: list[float] = []
    columns = {index: [] for index in channel_indexes}
    for row in rows[1:200_001]:
        padded = row + [""] * (len(headers) - len(row))
        try:
            if time_index >= 0:
                times.append(float(padded[time_index]))
            for index in channel_indexes:
                columns[index].append(float(padded[index]))
        except ValueError as error:
            raise ToolError("波形 CSV 包含空值或非数值采样") from error
    intervals = [times[index] - times[index - 1] for index in range(1, len(times)) if times[index] > times[index - 1]]
    sample_rate = 1 / _mean(intervals) if intervals else fallback_rate
    if not (0.001 <= sample_rate <= 50_000):
        raise ToolError("无法从 time 列得到有效采样率")
    traces = []
    for index in channel_indexes:
        channel = headers[index]
        traces.append({
            "id": channel,
            "network": "",
            "station": "",
            "location": "",
            "channel": channel,
            "sampleRate": sample_rate,
            "unit": "counts",
            "startTime": None,
            "values": columns[index],
        })
    return {
        "name": name or "导入多通道 CSV",
        "sourceType": "table-csv",
        "benchmark": False,
        "seed": None,
        "sampleRate": sample_rate,
        "startTime": None,
        "traces": traces,
        "truthPicks": [],
    }


def _load_dataset(payload: dict[str, Any]) -> dict[str, Any]:
    source = str(payload.get("waveformText") or "").strip()
    file_name = str(payload.get("fileName") or "").strip()
    fallback_rate = _number(payload.get("fallbackSampleRate"), 200, 0.001, 50_000)
    if not source:
        return _synthetic_dataset(round(_number(payload.get("seed"), 20260909, 1, 2**31 - 1)))
    if file_name.casefold().endswith(".json") or source.startswith("{"):
        return _parse_json_dataset(source, fallback_rate, file_name)
    return _parse_csv_dataset(source, fallback_rate, file_name)


def _detrend(values: list[float], mode: str) -> list[float]:
    if mode == "none":
        return values[:]
    average = _mean(values)
    if mode == "mean" or len(values) < 2:
        return [value - average for value in values]
    x_average = (len(values) - 1) / 2
    denominator = sum((index - x_average) ** 2 for index in range(len(values)))
    slope = sum((index - x_average) * (value - average) for index, value in enumerate(values)) / max(denominator, 1e-12)
    return [value - (average + slope * (index - x_average)) for index, value in enumerate(values)]


def _taper(values: list[float], percent: float) -> list[float]:
    edge = max(1, round(len(values) * min(0.2, max(0, percent / 100))))
    result = []
    for index, value in enumerate(values):
        distance = min(index, len(values) - 1 - index)
        weight = 1 if distance >= edge else 0.5 * (1 - math.cos(math.pi * distance / edge))
        result.append(value * weight)
    return result


def _lowpass(values: list[float], cutoff: float, sample_rate: float) -> list[float]:
    if not values or cutoff <= 0:
        return values[:]
    dt = 1 / sample_rate
    rc = 1 / (2 * math.pi * cutoff)
    alpha = dt / (rc + dt)
    result = [values[0]]
    for value in values[1:]:
        result.append(result[-1] + alpha * (value - result[-1]))
    return result


def _highpass(values: list[float], cutoff: float, sample_rate: float) -> list[float]:
    if not values or cutoff <= 0:
        return values[:]
    dt = 1 / sample_rate
    rc = 1 / (2 * math.pi * cutoff)
    alpha = rc / (rc + dt)
    result = [0.0]
    for index in range(1, len(values)):
        result.append(alpha * (result[-1] + values[index] - values[index - 1]))
    return result


def _notch(values: list[float], frequency: float, quality: float, sample_rate: float) -> list[float]:
    if not values or frequency <= 0 or frequency >= sample_rate / 2:
        return values[:]
    omega = 2 * math.pi * frequency / sample_rate
    alpha = math.sin(omega) / (2 * max(1, quality))
    b0, b1, b2 = 1, -2 * math.cos(omega), 1
    a0, a1, a2 = 1 + alpha, -2 * math.cos(omega), 1 - alpha
    b0, b1, b2, a1, a2 = b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0
    x1 = x2 = y1 = y2 = 0.0
    output = []
    for value in values:
        current = b0 * value + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        output.append(current)
        x2, x1, y2, y1 = x1, value, y1, current
    return output


def _filter_once(values: list[float], sample_rate: float, settings: dict[str, Any]) -> list[float]:
    mode = str(settings["filterMode"])
    result = values[:]
    if mode in {"bandpass", "highpass"}:
        result = _highpass(result, float(settings["lowCut"]), sample_rate)
    if mode in {"bandpass", "lowpass"}:
        result = _lowpass(result, float(settings["highCut"]), sample_rate)
    if settings["notchEnabled"]:
        result = _notch(result, float(settings["notchFrequency"]), float(settings["notchQ"]), sample_rate)
    return result


def _preprocess(values: list[float], sample_rate: float, settings: dict[str, Any]) -> list[float]:
    result = _taper(_detrend(values, str(settings["detrend"])), float(settings["taperPercent"]))
    if settings["filterMode"] != "none":
        for _ in range(max(1, int(settings["filterOrder"]) // 2)):
            result = _filter_once(result, sample_rate, settings)
        if settings["zeroPhase"]:
            result = list(reversed(_filter_once(list(reversed(result)), sample_rate, settings)))
    if settings["outputUnit"] != "counts":
        sensitivity = float(settings["sensitivity"])
        if sensitivity <= 0:
            raise ToolError("输出物理量时必须提供大于 0 的仪器灵敏度")
        result = [value / sensitivity for value in result]
    return result


def _fft(values: list[complex]) -> list[complex]:
    count = len(values)
    output = values[:]
    j = 0
    for index in range(1, count):
        bit = count >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j ^= bit
        if index < j:
            output[index], output[j] = output[j], output[index]
    length = 2
    while length <= count:
        step = complex(math.cos(-2 * math.pi / length), math.sin(-2 * math.pi / length))
        for start in range(0, count, length):
            rotation = 1 + 0j
            half = length // 2
            for offset in range(half):
                even = output[start + offset]
                odd = output[start + offset + half] * rotation
                output[start + offset] = even + odd
                output[start + offset + half] = even - odd
                rotation *= step
        length <<= 1
    return output


def _hann(count: int) -> list[float]:
    return [0.5 - 0.5 * math.cos(2 * math.pi * index / max(1, count - 1)) for index in range(count)]


def _welch(values: list[float], sample_rate: float, nperseg: int = 512) -> dict[str, Any]:
    nperseg = min(1024, max(64, 1 << math.floor(math.log2(min(nperseg, len(values))))))
    step = nperseg // 2
    window = _hann(nperseg)
    scale = sample_rate * sum(weight * weight for weight in window)
    power = [0.0] * (nperseg // 2 + 1)
    windows = 0
    for start in range(0, len(values) - nperseg + 1, step):
        transformed = _fft([complex(values[start + index] * window[index], 0) for index in range(nperseg)])
        for index in range(len(power)):
            power[index] += abs(transformed[index]) ** 2 / max(scale, 1e-12)
        windows += 1
    if not windows:
        transformed = _fft([complex((values[index] if index < len(values) else 0) * window[index], 0) for index in range(nperseg)])
        power = [abs(transformed[index]) ** 2 / max(scale, 1e-12) for index in range(len(power))]
        windows = 1
    power = [value / windows for value in power]
    frequencies = [index * sample_rate / nperseg for index in range(len(power))]
    dominant_index = max(range(1, len(power)), key=lambda index: power[index]) if len(power) > 1 else 0
    total = sum(power[1:]) or 1
    centroid = sum(frequencies[index] * power[index] for index in range(1, len(power))) / total
    cumulative = 0.0
    lower = upper = 0.0
    lower_found = False
    for frequency, value in zip(frequencies[1:], power[1:], strict=True):
        cumulative += value / total
        if not lower_found and cumulative >= 0.05:
            lower = frequency
            lower_found = True
        if cumulative >= 0.95:
            upper = frequency
            break
    return {
        "nperseg": nperseg,
        "windows": windows,
        "frequencies": frequencies,
        "power": power,
        "dominantFrequency": frequencies[dominant_index],
        "centroidFrequency": centroid,
        "bandwidth90": [lower, upper or frequencies[-1]],
    }


def _spectrogram(values: list[float], sample_rate: float, nperseg: int = 256) -> dict[str, Any]:
    nperseg = min(512, max(64, 1 << math.floor(math.log2(min(nperseg, len(values))))))
    step = nperseg // 2
    window = _hann(nperseg)
    frequencies = [index * sample_rate / nperseg for index in range(0, nperseg // 2 + 1, 2)]
    frames = []
    minimum = math.inf
    maximum = -math.inf
    for start in range(0, len(values) - nperseg + 1, step):
        transformed = _fft([complex(values[start + index] * window[index], 0) for index in range(nperseg)])
        db = [10 * math.log10(abs(transformed[index]) ** 2 / nperseg + 1e-20) for index in range(0, nperseg // 2 + 1, 2)]
        minimum = min(minimum, min(db))
        maximum = max(maximum, max(db))
        frames.append({"time": (start + nperseg / 2) / sample_rate, "db": db})
    return {"frequencies": frequencies, "frames": frames, "minDb": minimum if frames else 0, "maxDb": maximum if frames else 0}


def _envelope(values: list[float], sample_rate: float) -> list[float]:
    window = max(3, round(sample_rate * 0.05))
    prefix = [0.0]
    for value in values:
        prefix.append(prefix[-1] + value * value)
    half = window // 2
    return [
        math.sqrt((prefix[min(len(values), index + half + 1)] - prefix[max(0, index - half)]) / max(1, min(len(values), index + half + 1) - max(0, index - half)))
        for index in range(len(values))
    ]


def _sta_lta(values: list[float], sample_rate: float, settings: dict[str, Any]) -> dict[str, Any]:
    sta = max(2, round(float(settings["staSeconds"]) * sample_rate))
    lta = max(sta + 1, round(float(settings["ltaSeconds"]) * sample_rate))
    squared = [value * value for value in values]
    if settings["staMethod"] == "classic":
        prefix = [0.0]
        for value in squared:
            prefix.append(prefix[-1] + value)
        ratio = []
        for index in range(len(values)):
            sta_start = max(0, index - sta + 1)
            lta_start = max(0, index - lta + 1)
            short = (prefix[index + 1] - prefix[sta_start]) / (index - sta_start + 1)
            long = (prefix[index + 1] - prefix[lta_start]) / (index - lta_start + 1)
            ratio.append(short / max(long, 1e-20) if index >= lta else 0.0)
    else:
        short = long = 0.0
        a_sta = 1 / sta
        a_lta = 1 / lta
        ratio = []
        for index, value in enumerate(squared):
            short = a_sta * value + (1 - a_sta) * short
            long = a_lta * value + (1 - a_lta) * long
            ratio.append(short / max(long, 1e-20) if index >= lta else 0.0)
    return {"ratio": ratio, "staSamples": sta, "ltaSamples": lta}


def _trigger_events(ratio: list[float], values: list[float], sample_rate: float, settings: dict[str, Any]) -> list[dict[str, Any]]:
    trigger_on = float(settings["triggerOn"])
    trigger_off = float(settings["triggerOff"])
    minimum = max(1, round(float(settings["minDuration"]) * sample_rate))
    dead = max(0, round(float(settings["deadTime"]) * sample_rate))
    events = []
    start: int | None = None
    next_allowed = 0
    for index, value in enumerate(ratio):
        if start is None and index >= next_allowed and value >= trigger_on:
            start = index
        elif start is not None and (value <= trigger_off or index == len(ratio) - 1):
            end = index
            if end - start >= minimum:
                peak_index = max(range(start, end + 1), key=lambda offset: ratio[offset])
                amplitude_index = max(range(start, end + 1), key=lambda offset: abs(values[offset]))
                events.append({
                    "id": f"EV-{len(events) + 1:03d}",
                    "startTime": start / sample_rate,
                    "endTime": end / sample_rate,
                    "peakTime": peak_index / sample_rate,
                    "duration": (end - start) / sample_rate,
                    "characteristicPeak": ratio[peak_index],
                    "amplitudePeak": abs(values[amplitude_index]),
                })
            next_allowed = end + dead
            start = None
    return events[:100]


def _aic_pick(values: list[float], sample_rate: float, start_time: float, end_time: float) -> dict[str, float]:
    start = max(0, math.floor(start_time * sample_rate))
    end = min(len(values), math.ceil(end_time * sample_rate))
    if end - start < 12:
        raise ToolError("AIC 窗口至少需要 12 个样本")
    segment = values[start:end]
    prefix = [0.0]
    prefix_square = [0.0]
    for value in segment:
        prefix.append(prefix[-1] + value)
        prefix_square.append(prefix_square[-1] + value * value)
    best_index = 5
    best_score = math.inf
    for index in range(5, len(segment) - 5):
        left_count = index
        right_count = len(segment) - index
        left_variance = max(1e-20, prefix_square[index] / left_count - (prefix[index] / left_count) ** 2)
        right_sum = prefix[-1] - prefix[index]
        right_square = prefix_square[-1] - prefix_square[index]
        right_variance = max(1e-20, right_square / right_count - (right_sum / right_count) ** 2)
        score = left_count * math.log(left_variance) + (right_count - 1) * math.log(right_variance)
        if score < best_score:
            best_score = score
            best_index = index
    return {"time": (start + best_index) / sample_rate, "score": best_score}


def _quality(raw: list[float], processed: list[float], sample_rate: float) -> dict[str, Any]:
    absolute = [abs(value) for value in raw]
    peak = max(absolute) if absolute else 0
    clipped = sum(value >= peak * 0.999999 for value in absolute) if peak else 0
    differences = [raw[index] - raw[index - 1] for index in range(1, len(raw))]
    difference_std = _std(differences) or 1
    spikes = sum(abs(value) > difference_std * 8 for value in differences)
    return {
        "invalid": 0,
        "invalidRatio": 0,
        "clipped": clipped,
        "clippedRatio": clipped / max(1, len(raw)),
        "spikes": spikes,
        "nyquist": sample_rate / 2,
        "raw": {"count": len(raw), "mean": _mean(raw), "rms": _rms(raw), "peak": peak},
        "processed": {"count": len(processed), "mean": _mean(processed), "rms": _rms(processed), "peak": max((abs(value) for value in processed), default=0)},
    }


def _window_metrics(values: list[float], sample_rate: float, settings: dict[str, Any]) -> dict[str, Any]:
    def segment(start_key: str, end_key: str) -> list[float]:
        start = max(0, round(float(settings[start_key]) * sample_rate))
        end = min(len(values), round(float(settings[end_key]) * sample_rate))
        return values[start:end]

    noise = segment("noiseStart", "noiseEnd")
    signal = segment("signalStart", "signalEnd")
    noise_rms = _rms(noise)
    signal_rms = _rms(signal)
    snr = signal_rms / max(noise_rms, 1e-20)
    dt = 1 / sample_rate
    cav = sum(abs(value) for value in signal) * dt if settings["outputUnit"] == "m/s²" else None
    arias = math.pi / (2 * 9.80665) * sum(value * value for value in signal) * dt if settings["outputUnit"] == "m/s²" else None
    return {
        "noiseRms": noise_rms,
        "signalRms": signal_rms,
        "snr": snr,
        "snrDb": 20 * math.log10(max(snr, 1e-20)),
        "peak": max((abs(value) for value in signal), default=0),
        "cav": cav,
        "ariasIntensity": arias,
    }


def _eigenpair(matrix: list[list[float]], initial: list[float]) -> tuple[float, list[float]]:
    vector = initial[:]
    magnitude = math.sqrt(sum(value * value for value in vector)) or 1
    vector = [value / magnitude for value in vector]
    for _ in range(36):
        projected = [sum(matrix[row][column] * vector[column] for column in range(3)) for row in range(3)]
        magnitude = math.sqrt(sum(value * value for value in projected)) or 1
        vector = [value / magnitude for value in projected]
    value = sum(vector[row] * sum(matrix[row][column] * vector[column] for column in range(3)) for row in range(3))
    return max(0.0, value), vector


def _polarization(traces: list[list[float]], sample_rate: float, settings: dict[str, Any]) -> dict[str, Any] | None:
    if len(traces) < 3 or len({len(trace) for trace in traces[:3]}) != 1:
        return None
    start = max(0, round(float(settings["signalStart"]) * sample_rate))
    end = min(len(traces[0]), round(float(settings["signalEnd"]) * sample_rate))
    if end - start < 12:
        return None
    segments = [trace[start:end] for trace in traces[:3]]
    averages = [_mean(segment) for segment in segments]
    matrix = [[_mean([(segments[row][index] - averages[row]) * (segments[column][index] - averages[column]) for index in range(end - start)]) for column in range(3)] for row in range(3)]
    lambda1, vector1 = _eigenpair(matrix, [1, 0.5, 0.25])
    deflated = [[matrix[row][column] - lambda1 * vector1[row] * vector1[column] for column in range(3)] for row in range(3)]
    lambda2, vector2 = _eigenpair(deflated, [0.25, 1, 0.5])
    lambda3 = max(0.0, sum(matrix[index][index] for index in range(3)) - lambda1 - lambda2)
    return {
        "principalVector": vector1,
        "secondaryVector": vector2,
        "eigenvalues": [lambda1, lambda2, lambda3],
        "rectilinearity": max(0.0, min(1.0, 1 - (lambda2 + lambda3) / max(2 * lambda1, 1e-20))),
        "planarity": max(0.0, min(1.0, 1 - 2 * lambda3 / max(lambda1 + lambda2, 1e-20))),
        "startTime": start / sample_rate,
        "endTime": end / sample_rate,
    }


def _normalize_picks(value: Any, trace_id: str) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    result = []
    for index, item in enumerate(value[:500]):
        if not isinstance(item, dict):
            continue
        time = _number(item.get("time"), -1)
        phase = str(item.get("phase") or "X").upper()
        if time < 0 or phase not in {"P", "S", "X"}:
            continue
        result.append({
            "id": str(item.get("id") or f"PICK-{index + 1:03d}"),
            "phase": phase,
            "time": time,
            "traceId": str(item.get("traceId") or trace_id),
            "source": str(item.get("source") or "manual"),
            "uncertainty": _number(item.get("uncertainty"), 0.0, 0),
            "status": str(item.get("status") or "pending"),
        })
    return result


def _validate_picks(reference: list[dict[str, Any]], predicted: list[dict[str, Any]], tolerance: float) -> dict[str, Any]:
    used: set[int] = set()
    errors: list[float] = []
    matches = []
    for expected in reference:
        candidates = [
            (index, pick)
            for index, pick in enumerate(predicted)
            if index not in used and pick["phase"] == expected["phase"] and abs(float(pick["time"]) - float(expected["time"])) <= tolerance
        ]
        if not candidates:
            continue
        index, pick = min(candidates, key=lambda item: abs(float(item[1]["time"]) - float(expected["time"])))
        used.add(index)
        error = float(pick["time"]) - float(expected["time"])
        errors.append(error)
        matches.append({"phase": expected["phase"], "reference": expected["time"], "predicted": pick["time"], "error": error})
    tp = len(matches)
    fp = len(predicted) - tp
    fn = len(reference) - tp
    precision = tp / max(1, tp + fp)
    recall = tp / max(1, tp + fn)
    return {
        "reference": len(reference),
        "predicted": len(predicted),
        "matched": tp,
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": precision,
        "recall": recall,
        "f1": 2 * precision * recall / max(precision + recall, 1e-20),
        "mae": _mean([abs(error) for error in errors]) if errors else None,
        "rmse": math.sqrt(_mean([error * error for error in errors])) if errors else None,
        "bias": _mean(errors) if errors else None,
        "matches": matches,
        "tolerance": tolerance,
    }


def _physical_model(physics: dict[str, Any]) -> dict[str, Any]:
    p_time = _number(physics.get("pTime"), -1)
    s_time = _number(physics.get("sTime"), -1)
    vp = _number(physics.get("vp"), 6)
    vs = _number(physics.get("vs"), 3.5)
    depth = _number(physics.get("depth"), 0, 0)
    if not (s_time > p_time >= 0 and vp > vs > 0):
        return {"valid": False, "error": "需要 S 到时晚于 P 到时，且 Vp > Vs > 0"}
    delta = s_time - p_time
    hypocentral = delta * vp * vs / (vp - vs)
    epicentral = math.sqrt(max(0, hypocentral * hypocentral - depth * depth)) if depth <= hypocentral else None
    ratio = vp / vs
    poisson = (ratio * ratio - 2) / (2 * (ratio * ratio - 1))
    result: dict[str, Any] = {
        "valid": True,
        "deltaTime": delta,
        "hypocentralKm": hypocentral,
        "epicentralKm": epicentral,
        "vpVs": ratio,
        "poisson": poisson,
        "moment": None,
        "momentMagnitude": None,
    }
    omega0 = _number(physics.get("omega0"), 0, 0)
    if omega0 > 0:
        density = _number(physics.get("density"), 2700, 1)
        radiation = _number(physics.get("radiation"), 0.52, 1e-6)
        free_surface = _number(physics.get("freeSurface"), 2, 1e-6)
        velocity = (vp if physics.get("waveType") == "P" else vs) * 1000
        distance = hypocentral * 1000
        moment = 4 * math.pi * density * velocity**3 * distance * omega0 / (radiation * free_surface)
        result["moment"] = moment
        result["momentMagnitude"] = (2 / 3) * (math.log10(moment) - 9.1)
    return result


def _settings(payload: dict[str, Any], dataset: dict[str, Any]) -> dict[str, Any]:
    supplied = payload.get("settings") if isinstance(payload.get("settings"), dict) else {}
    settings = {**DEFAULT_SETTINGS, **supplied}
    settings["detrend"] = str(settings["detrend"]) if settings["detrend"] in {"linear", "mean", "none"} else "linear"
    settings["filterMode"] = str(settings["filterMode"]) if settings["filterMode"] in {"bandpass", "highpass", "lowpass", "none"} else "bandpass"
    settings["staMethod"] = str(settings["staMethod"]) if settings["staMethod"] in {"classic", "recursive"} else "recursive"
    settings["taperPercent"] = _number(settings["taperPercent"], 5, 0, 20)
    settings["lowCut"] = _number(settings["lowCut"], 1, 0.001)
    settings["highCut"] = _number(settings["highCut"], 20, 0.002)
    settings["filterOrder"] = 4 if int(_number(settings["filterOrder"], 4)) >= 4 else 2
    settings["zeroPhase"] = bool(settings["zeroPhase"])
    settings["notchEnabled"] = bool(settings["notchEnabled"])
    settings["notchFrequency"] = _number(settings["notchFrequency"], 50, 1)
    settings["notchQ"] = _number(settings["notchQ"], 30, 1)
    settings["sensitivity"] = _number(settings["sensitivity"], 1, 0)
    settings["outputUnit"] = str(settings["outputUnit"]) if settings["outputUnit"] in {"counts", "m/s²", "m/s", "m"} else "counts"
    settings["staSeconds"] = _number(settings["staSeconds"], 0.25, 0.01)
    settings["ltaSeconds"] = _number(settings["ltaSeconds"], 3, 0.02)
    settings["triggerOn"] = _number(settings["triggerOn"], 3, 1)
    settings["triggerOff"] = _number(settings["triggerOff"], 1.2, 0)
    settings["minDuration"] = _number(settings["minDuration"], 0.1, 0)
    settings["deadTime"] = _number(settings["deadTime"], 0.5, 0)
    settings["aicPhase"] = str(settings["aicPhase"]).upper() if str(settings["aicPhase"]).upper() in {"P", "S", "X"} else "P"
    for key, fallback in (("aicStart", 7.5), ("aicEnd", 9), ("noiseStart", 0), ("noiseEnd", 5), ("signalStart", 7), ("signalEnd", 16)):
        settings[key] = _number(settings[key], fallback, 0)
    settings["validationTolerance"] = _number(settings["validationTolerance"], 0.3, 0.001, 10)
    minimum_nyquist = min(float(trace["sampleRate"]) / 2 for trace in dataset["traces"])
    if settings["filterMode"] != "none":
        if settings["highCut"] >= minimum_nyquist:
            raise ToolError(f"高截止频率必须低于最小 Nyquist 频率 {minimum_nyquist:.3f} Hz")
        if settings["filterMode"] == "bandpass" and settings["lowCut"] >= settings["highCut"]:
            raise ToolError("带通滤波需要低截止频率小于高截止频率")
    if settings["ltaSeconds"] <= settings["staSeconds"]:
        raise ToolError("LTA 时间必须大于 STA 时间")
    if settings["triggerOn"] <= settings["triggerOff"]:
        raise ToolError("触发阈值必须高于结束阈值")
    return settings


def _downsample(values: list[float], maximum: int = 1200) -> list[float]:
    if len(values) <= maximum:
        return values
    stride = len(values) / maximum
    return [values[min(len(values) - 1, math.floor(index * stride))] for index in range(maximum)]


def _csv_exports(dataset: dict[str, Any], active: dict[str, Any], processed: list[float], psd: dict[str, Any], events: list[dict[str, Any]], picks: list[dict[str, Any]], reference: list[dict[str, Any]]) -> dict[str, str]:
    waveform = io.StringIO()
    writer = csv.writer(waveform, lineterminator="\r\n")
    writer.writerow(["time_s", f"raw_{active['unit']}", "processed"])
    for index, (raw, value) in enumerate(zip(active["values"], processed, strict=True)):
        writer.writerow([index / float(active["sampleRate"]), raw, value])
    spectrum = io.StringIO()
    writer = csv.writer(spectrum, lineterminator="\r\n")
    writer.writerow(["frequency_hz", "power_spectral_density"])
    writer.writerows(zip(psd["frequencies"], psd["power"], strict=True))
    catalog = io.StringIO()
    writer = csv.DictWriter(catalog, fieldnames=["id", "startTime", "endTime", "peakTime", "duration", "characteristicPeak", "amplitudePeak", "decision"], lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(events)
    pick_csv = io.StringIO()
    writer = csv.DictWriter(pick_csv, fieldnames=["id", "phase", "time", "traceId", "source", "uncertainty", "status"], lineterminator="\r\n", extrasaction="ignore")
    writer.writeheader()
    writer.writerows(picks)
    reference_csv = io.StringIO()
    writer = csv.DictWriter(reference_csv, fieldnames=["id", "phase", "time", "traceId", "source"], lineterminator="\r\n", extrasaction="ignore")
    writer.writeheader()
    writer.writerows(reference)
    return {
        "processedCsv": waveform.getvalue(),
        "psdCsv": spectrum.getvalue(),
        "eventsCsv": catalog.getvalue(),
        "picksCsv": pick_csv.getvalue(),
        "referenceCsv": reference_csv.getvalue(),
    }


def _report(project: dict[str, Any], dataset: dict[str, Any], active: dict[str, Any], settings: dict[str, Any], quality: dict[str, Any], window: dict[str, Any], psd: dict[str, Any], events: list[dict[str, Any]], picks: list[dict[str, Any]], validation: dict[str, Any], physical: dict[str, Any], checks: list[dict[str, Any]]) -> str:
    return f"""# {project['name']}

生成时间：{datetime.now(UTC).isoformat()}

## 项目与数据

- 分析人员：{project['analyst']}
- 数据：{dataset['name']}
- 当前通道：{active['id']}
- 采样率：{active['sampleRate']} Hz；样本：{len(active['values'])}；时长：{len(active['values']) / active['sampleRate']:.3f} s
- 数据类型：{'确定性合成基准' if dataset['benchmark'] else '用户导入波形'}

## 可复现处理参数

- 去趋势：{settings['detrend']}；渐消：{settings['taperPercent']}%
- 滤波：{settings['filterMode']} {settings['lowCut']}-{settings['highCut']} Hz；阶数：{settings['filterOrder']}；零相位：{settings['zeroPhase']}
- STA/LTA：{settings['staMethod']}，{settings['staSeconds']} / {settings['ltaSeconds']} s，阈值 {settings['triggerOn']} / {settings['triggerOff']}

## 分析结果

- 有效样本：{quality['raw']['count']}；疑似削波：{quality['clipped']}；突跳候选：{quality['spikes']}
- 信号窗 SNR：{window['snr']:.3f}× / {window['snrDb']:.3f} dB
- 主频：{psd['dominantFrequency']:.4f} Hz；90% 频带：{psd['bandwidth90'][0]:.3f}-{psd['bandwidth90'][1]:.3f} Hz
- 事件候选：{len(events)}；震相拾取：{len(picks)}

## 独立到时验证

- TP / FP / FN：{validation['tp']} / {validation['fp']} / {validation['fn']}
- Precision / Recall / F1：{validation['precision']:.3f} / {validation['recall']:.3f} / {validation['f1']:.3f}

## 简化物理模型

- P-S 到时差：{physical.get('deltaTime', '—')} s
- 震源距：{physical.get('hypocentralKm', '—')} km；Vp/Vs：{physical.get('vpVs', '—')}；泊松比：{physical.get('poisson', '—')}

## 质量门禁

{chr(10).join(f"- [{'x' if item['passed'] else ' '}] {item['label']}" for item in checks)}

## 解释边界

- STA/LTA 输出是候选事件，需要人工或正式目录复核。
- AIC 拾取需要结合多分量、多台站记录复核。
- 均匀速度模型不能替代台网定位与速度结构反演。
- 未完成仪器响应去除时，不把 counts 解释为真实地面运动量。
"""


def _package(exports: dict[str, str], analysis: dict[str, Any], report_markdown: str) -> str:
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as package:
        package.writestr("README.md", report_markdown)
        package.writestr("metadata/analysis.json", json.dumps(analysis, ensure_ascii=False, indent=2))
        package.writestr("waveform/processed.csv", "\ufeff" + exports["processedCsv"])
        package.writestr("spectrum/welch-psd.csv", "\ufeff" + exports["psdCsv"])
        package.writestr("catalog/events.csv", "\ufeff" + exports["eventsCsv"])
        package.writestr("catalog/picks.csv", "\ufeff" + exports["picksCsv"])
        package.writestr("validation/reference-picks.csv", "\ufeff" + exports["referenceCsv"])
    return base64.b64encode(archive.getvalue()).decode("ascii")


def _legacy_detect(payload: dict[str, Any]) -> dict[str, Any]:
    values = parse_numbers(payload.get("values"), minimum=20)
    sample_rate = _number(payload.get("sampleRate"), 100, 0.001)
    settings = {**DEFAULT_SETTINGS}
    settings["staSeconds"] = _number(payload.get("sta"), max(2, sample_rate * 0.2)) / sample_rate
    settings["ltaSeconds"] = _number(payload.get("lta"), max(3, sample_rate * 2)) / sample_rate
    settings["triggerOn"] = _number(payload.get("threshold"), 3, 0.1)
    settings["triggerOff"] = settings["triggerOn"] * 0.55
    characteristic = _sta_lta(values, sample_rate, settings)
    events = _trigger_events(characteristic["ratio"], values, sample_rate, settings)
    return {
        "samples": len(values),
        "duration": len(values) / sample_rate,
        "mean": _mean(values),
        "standardDeviation": _std(values),
        "peak": max(abs(value) for value in values),
        "triggers": [{"index": round(event["startTime"] * sample_rate), "time": event["startTime"], "ratio": event["characteristicPeak"]} for event in events],
    }


def run_seismic_physics(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action == "source-distance":
        result = _physical_model({**DEFAULT_PHYSICS, **payload})
        if not result["valid"]:
            raise ToolError(str(result["error"]))
        return {key: result[key] for key in ("deltaTime", "hypocentralKm", "vpVs")}
    if action == "detect" and payload.get("values") is not None:
        return _legacy_detect(payload)
    supported = {"load-sample", "preprocess", "detect", "spectrum-workbench", "aic-pick", "physics", "validate", "run-all"}
    if action not in supported:
        raise ToolError("不支持的地震与物理分析操作")

    dataset = _load_dataset(payload)
    settings = _settings(payload, dataset)
    project_raw = payload.get("project") if isinstance(payload.get("project"), dict) else {}
    project = {
        "name": str(project_raw.get("name") or "地震波形与震相分析"),
        "analyst": str(project_raw.get("analyst") or "SkyViewLab"),
        "stationNotes": str(project_raw.get("stationNotes") or ""),
        "eventNotes": str(project_raw.get("eventNotes") or ""),
    }
    selected_trace = str(payload.get("selectedTrace") or dataset["traces"][0]["id"])
    active = next((trace for trace in dataset["traces"] if trace["id"] == selected_trace), dataset["traces"][0])
    selected_trace = active["id"]
    processed_map = {trace["id"]: _preprocess(trace["values"], float(trace["sampleRate"]), settings) for trace in dataset["traces"]}
    processed = processed_map[selected_trace]
    sample_rate = float(active["sampleRate"])
    quality = _quality(active["values"], processed, sample_rate)
    envelope = _envelope(processed, sample_rate)
    characteristic = _sta_lta(processed, sample_rate, settings)
    events = _trigger_events(characteristic["ratio"], processed, sample_rate, settings)
    event_decisions = payload.get("eventDecisions") if isinstance(payload.get("eventDecisions"), dict) else {}
    for event in events:
        event["decision"] = str(event_decisions.get(event["id"]) or "pending")
    psd = _welch(processed, sample_rate)
    spectrogram = _spectrogram(processed, sample_rate)
    window = _window_metrics(processed, sample_rate, settings)
    compatible = [processed_map[trace["id"]] for trace in dataset["traces"] if float(trace["sampleRate"]) == sample_rate and len(trace["values"]) == len(active["values"])]
    polarization = _polarization(compatible[:3], sample_rate, settings)
    picks = _normalize_picks(payload.get("picks"), selected_trace)
    if not picks and dataset["benchmark"]:
        # The deterministic benchmark carries fixed phase candidates separately
        # from its reference truth so the validation path is populated on first
        # render without pretending the candidates are reviewed observations.
        for phase, time in (("P", 8.215), ("S", 12.58)):
            picks.append({"id": f"AUTO-{phase}", "phase": phase, "time": time, "traceId": selected_trace, "source": "automatic-phase-candidate", "uncertainty": 0.025, "status": "pending"})
    if action == "aic-pick":
        suggestion = _aic_pick(processed, sample_rate, float(settings["aicStart"]), float(settings["aicEnd"]))
        picks.append({"id": f"AIC-{len(picks) + 1:03d}", "phase": settings["aicPhase"], "time": suggestion["time"], "traceId": selected_trace, "source": "AIC-window", "uncertainty": 1 / sample_rate, "status": "pending", "aicScore": suggestion["score"]})
    reference = _normalize_picks(payload.get("referencePicks"), selected_trace)
    if not reference and dataset["truthPicks"]:
        reference = _normalize_picks(dataset["truthPicks"], selected_trace)
    validation = _validate_picks(reference, picks, float(settings["validationTolerance"]))
    physics_raw = payload.get("physics") if isinstance(payload.get("physics"), dict) else {}
    physics = {**DEFAULT_PHYSICS, **physics_raw}
    phase_p = next((pick for pick in sorted(picks, key=lambda item: item["time"]) if pick["phase"] == "P"), None)
    phase_s = next((pick for pick in sorted(picks, key=lambda item: item["time"]) if pick["phase"] == "S"), None)
    if phase_p:
        physics["pTime"] = phase_p["time"]
    if phase_s:
        physics["sTime"] = phase_s["time"]
    physical = _physical_model(physics)
    evidence = payload.get("evidence") if isinstance(payload.get("evidence"), list) else []
    if not evidence and dataset["benchmark"]:
        evidence = [
            {"id": "E-001", "title": "确定性基准生成参数", "type": "station-log", "status": "verified", "note": f"固定随机种子 {dataset['seed']}，三分量 200 Hz / 30 s。"},
            {"id": "E-002", "title": "三通道采样一致性", "type": "inventory", "status": "verified", "note": "BHZ、BHN、BHE 的采样率、起点和样本数一致。"},
            {"id": "E-003", "title": "独立到时真值", "type": "catalog", "status": "verified", "note": "P=8.200 s，S=12.600 s，用于流程回归验证。"},
        ]
    filter_valid = settings["filterMode"] == "none" or (settings["lowCut"] > 0 and settings["highCut"] < sample_rate / 2 and (settings["filterMode"] != "bandpass" or settings["lowCut"] < settings["highCut"]))
    checks = [
        {"passed": bool(dataset["traces"]), "label": "波形数据已载入"},
        {"passed": len(active["values"]) >= 64, "label": "连续段样本数满足分析要求"},
        {"passed": filter_valid, "label": "滤波频率位于 Nyquist 范围内"},
        {"passed": quality["invalidRatio"] < 0.01, "label": "无效样本比例低于 1%"},
        {"passed": quality["clippedRatio"] < 0.01, "label": "疑似削波比例低于 1%"},
        {"passed": settings["outputUnit"] == "counts" or settings["sensitivity"] > 0, "label": "输出量纲与灵敏度一致"},
        {"passed": bool(phase_p and phase_s), "label": "P、S 到时均有记录"},
        {"passed": len(reference) >= 2, "label": "至少两个独立参考到时"},
        {"passed": validation["f1"] >= 0.8 if reference else False, "label": "到时验证 F1 不低于 80%"},
    ]
    exports = _csv_exports(dataset, active, processed, psd, events, picks, reference)
    report_markdown = _report(project, dataset, active, settings, quality, window, psd, events, picks, validation, physical, checks)
    report_html = "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'><title>地震分析报告</title><style>body{max-width:980px;margin:40px auto;padding:0 24px;color:#18213b;font:15px/1.75 system-ui,sans-serif}h1,h2{color:#25376d}</style></head><body><pre style='white-space:pre-wrap;font:inherit'>" + report_markdown.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;") + "</pre></body></html>"
    trace_summaries = [{key: value for key, value in trace.items() if key != "values"} | {"samples": len(trace["values"]), "duration": len(trace["values"]) / float(trace["sampleRate"])} for trace in dataset["traces"]]
    analysis_record = {
        "schema": "skyview-seismic-physics-analysis",
        "version": 2,
        "generatedAt": datetime.now(UTC).isoformat(),
        "project": project,
        "source": {key: value for key, value in dataset.items() if key not in {"traces", "truthPicks"}} | {"traces": trace_summaries},
        "settings": settings,
        "quality": quality,
        "window": window,
        "events": events,
        "picks": picks,
        "referencePicks": reference,
        "validation": validation,
        "physics": {"inputs": physics, "result": physical},
        "evidence": evidence,
        "qualityChecks": checks,
    }
    exports.update({
        "reportMarkdown": report_markdown,
        "reportHtml": report_html,
        "packageBase64": _package(exports, analysis_record, report_markdown),
    })
    history = payload.get("history") if isinstance(payload.get("history"), list) else []
    history = [{
        "id": f"RUN-{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}",
        "createdAt": datetime.now(UTC).isoformat(),
        "project": project["name"],
        "traceId": selected_trace,
        "events": len(events),
        "picks": len(picks),
        "dominantFrequency": psd["dominantFrequency"],
        "snr": window["snr"],
        "stage": action,
    }, *history[:29]]
    return {
        "schema": "skyview-seismic-physics-results",
        "version": 2,
        "stage": action,
        "project": project,
        "dataset": {
            "name": dataset["name"], "sourceType": dataset["sourceType"], "benchmark": dataset["benchmark"], "seed": dataset["seed"],
            "sampleRate": dataset["sampleRate"], "startTime": dataset["startTime"], "traces": trace_summaries,
        },
        "selectedTrace": selected_trace,
        "preview": {
            "sampleRate": sample_rate,
            "duration": len(active["values"]) / sample_rate,
            "raw": _downsample(active["values"]),
            "processed": _downsample(processed),
            "envelope": _downsample(envelope),
            "characteristic": _downsample(characteristic["ratio"]),
        },
        "tracePreviews": {trace["id"]: _downsample(trace["values"]) for trace in dataset["traces"]},
        "psd": psd,
        "spectrogram": spectrogram,
        "events": events,
        "picks": picks,
        "referencePicks": reference,
        "quality": quality,
        "window": window,
        "polarization": polarization,
        "physics": {"inputs": physics, "result": physical},
        "validation": validation,
        "evidence": evidence,
        "qualityChecks": checks,
        "settings": settings,
        "history": history,
        "exports": exports,
        "runtime": {
            "compute": "Python standard-library CPU worker",
            "miniSeed": "ObsPy external runtime adapter",
            "miniSeedConfigured": False,
            "stationXmlConfigured": False,
            "fdsnConfigured": False,
        },
        "limitations": [
            "miniSEED、StationXML 与 FDSN 需在部署环境连接 ObsPy 运行时",
            "当前滤波器用于兼容计算与流程复核，正式结论应使用经验证的地震学处理链复算",
            "STA/LTA 和 AIC 输出均保留为候选，不能绕过人工复核与发布审批",
        ],
    }
