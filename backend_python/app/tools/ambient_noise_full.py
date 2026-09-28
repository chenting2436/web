from __future__ import annotations

import csv
import io
import math
from typing import Any, Callable

from app.tools.common import ToolError, parse_numbers


DEFAULT_OPTIONS: dict[str, Any] = {
    "lowHz": 0.1,
    "highHz": 1.05,
    "taper": 0.05,
    "normalization": "ramn",
    "normalizationWindow": 5,
    "clipSigma": 4,
    "maxLagSeconds": 10,
    "minVelocity": 0.7,
    "maxVelocity": 4,
    "minSnr": 1.8,
    "minSymmetry": 0.15,
    "limit": 18,
    "minDispersionSnr": 1.4,
}

DEFAULT_TOMOGRAPHY: dict[str, Any] = {
    "period": 4,
    "nx": 10,
    "ny": 8,
    "damping": 0.18,
    "smoothing": 0.22,
    "iterations": 140,
}


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _std(values: list[float]) -> float:
    average = _mean(values)
    return math.sqrt(_mean([(value - average) ** 2 for value in values]))


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    return ordered[len(ordered) // 2] if ordered else 0.0


def _detrend(values: list[float]) -> list[float]:
    count = len(values)
    if count < 2:
        return values[:]
    x_mean = (count - 1) / 2
    y_mean = _mean(values)
    numerator = sum((index - x_mean) * (value - y_mean) for index, value in enumerate(values))
    denominator = sum((index - x_mean) ** 2 for index in range(count))
    slope = numerator / denominator if denominator else 0.0
    return [value - (y_mean + slope * (index - x_mean)) for index, value in enumerate(values)]


def _taper(values: list[float], fraction: float = 0.05) -> list[float]:
    edge = max(1, math.floor(len(values) * min(0.25, max(0.0, fraction))))
    result = []
    for index, value in enumerate(values):
        distance = min(index, len(values) - 1 - index)
        weight = 1.0 if distance >= edge else 0.5 * (1 - math.cos(math.pi * distance / edge))
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


def _bandpass(values: list[float], low: float, high: float, sample_rate: float, passes: int = 2) -> list[float]:
    result = values[:]
    for _ in range(max(1, passes)):
        result = _lowpass(_highpass(result, low, sample_rate), high, sample_rate)
    return result


def _ramn(values: list[float], window_samples: int) -> list[float]:
    half = max(1, window_samples // 2)
    prefix = [0.0]
    for value in values:
        prefix.append(prefix[-1] + abs(value))
    result = []
    for index, value in enumerate(values):
        start = max(0, index - half)
        end = min(len(values), index + half + 1)
        scale = (prefix[end] - prefix[start]) / max(1, end - start)
        result.append(value / scale if scale > 1e-12 else 0.0)
    return result


def _preprocess(values: list[float], sample_rate: float, options: dict[str, Any]) -> list[float]:
    result = _taper(_detrend(values), float(options["taper"]))
    low = float(options["lowHz"])
    high = min(sample_rate * 0.48, float(options["highHz"]))
    if high > low:
        result = _bandpass(result, low, high, sample_rate)
    if options["normalization"] == "onebit":
        result = [0 if value == 0 else math.copysign(1, value) for value in result]
    elif options["normalization"] == "ramn":
        result = _ramn(result, max(3, round(float(options["normalizationWindow"]) * sample_rate)))
    if float(options["clipSigma"]) > 0:
        limit = (_std(result) or 1) * float(options["clipSigma"])
        result = [max(-limit, min(limit, value)) for value in result]
    return result


def _correlation(left: list[float], right: list[float], min_lag: int, max_lag: int) -> dict[str, list[float]]:
    lags: list[float] = []
    values: list[float] = []
    for lag in range(math.floor(min_lag), math.ceil(max_lag) + 1):
        start = max(0, -lag)
        end = min(len(left), len(right) - lag)
        pairs = [(left[index], right[index + lag]) for index in range(start, end)]
        numerator = sum(a * b for a, b in pairs)
        aa = sum(a * a for a, _ in pairs)
        bb = sum(b * b for _, b in pairs)
        lags.append(float(lag))
        values.append(numerator / math.sqrt(aa * bb) if pairs and aa and bb else 0.0)
    return {"lags": lags, "values": values}


def _peak(correlation: dict[str, list[float]], min_lag: float, max_lag: float) -> dict[str, float]:
    best = {"lag": 0.0, "value": 0.0}
    for lag, value in zip(correlation["lags"], correlation["values"], strict=True):
        if min_lag <= lag <= max_lag and abs(value) > abs(best["value"]):
            best = {"lag": lag, "value": value}
    return best


def _mulberry32(seed: int) -> Callable[[], float]:
    state = seed & 0xFFFFFFFF

    def random() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        value = state
        value = ((value ^ (value >> 15)) * (value | 1)) & 0xFFFFFFFF
        value ^= (value + (((value ^ (value >> 7)) * (value | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((value ^ (value >> 14)) & 0xFFFFFFFF) / 4294967296

    return random


def _synthetic_network(seed: int = 20260809) -> dict[str, Any]:
    random = _mulberry32(seed)
    sample_rate = 5.0
    samples = 600
    coordinates = [
        ("SV01", 0.6, 1.0), ("SV02", 3.1, 0.5), ("SV03", 6.0, 1.3),
        ("SV04", 1.2, 4.0), ("SV05", 4.0, 3.5), ("SV06", 7.0, 4.4),
        ("SV07", 0.7, 7.1), ("SV08", 3.7, 6.6), ("SV09", 6.7, 7.4),
    ]
    stations = [
        {"id": station_id, "x": x, "y": y, "elevation": 420 + index * 23,
         "channel": "BHZ", "availability": 0.94 + (index % 4) * 0.012}
        for index, (station_id, x, y) in enumerate(coordinates)
    ]
    wavefield = [
        (0.18, 2.35, 0.38, 0.95), (0.26, 2.12, 1.42, 0.72),
        (0.38, 1.82, 2.18, 0.48), (0.52, 1.56, 2.81, 0.30),
    ]
    traces: dict[str, list[float]] = {}
    for station_index, station in enumerate(stations):
        values = []
        for index in range(samples):
            time = index / sample_rate
            coherent = 0.0
            for frequency, velocity, azimuth, amplitude in wavefield:
                projection = station["x"] * math.cos(azimuth) + station["y"] * math.sin(azimuth)
                coherent += amplitude * math.sin(2 * math.pi * frequency * (time - projection / velocity))
            noise = (random() - 0.5) * 0.72 + math.sin(index * 0.017 + station_index) * 0.08
            transient = (random() - 0.5) * 3.5 if index % 173 == station_index * 3 else 0.0
            values.append(coherent + noise + transient)
        traces[str(station["id"])] = values
    return {
        "schema": "skyview-ambient-noise", "benchmark": True, "seed": seed,
        "sampleRate": sample_rate, "startTime": "2026-08-09T00:00:00.000Z",
        "stations": stations, "traces": traces,
    }


def _parse_csv(source: str) -> dict[str, Any]:
    reader = csv.reader(io.StringIO(source.lstrip("\ufeff")))
    rows = [row for row in reader if any(cell.strip() for cell in row)]
    if len(rows) < 9:
        raise ToolError("波形 CSV 至少需要表头和 8 行数据")
    headers = [cell.strip() for cell in rows[0]]
    time_index = next((index for index, value in enumerate(headers) if value.lower() in {"time", "timestamp", "t"}), -1)
    station_headers = [value for index, value in enumerate(headers) if index != time_index and value]
    if len(station_headers) < 2:
        raise ToolError("波形 CSV 至少需要两列台站数据")
    traces = {station: [] for station in station_headers}
    times: list[float] = []
    for row in rows[1:20_001]:
        padded = row + [""] * (len(headers) - len(row))
        if time_index >= 0:
            try:
                times.append(float(padded[time_index]))
            except ValueError as error:
                raise ToolError("time 列必须是秒数") from error
        for station in station_headers:
            index = headers.index(station)
            try:
                traces[station].append(float(padded[index] or 0))
            except ValueError as error:
                raise ToolError(f"{station} 包含非数值波形") from error
    intervals = [times[index] - times[index - 1] for index in range(1, len(times))]
    sample_rate = 1 / max(1e-9, _mean(intervals)) if intervals else 1.0
    stations = [
        {"id": station, "x": (index % 4) * 2.5, "y": (index // 4) * 2.5,
         "elevation": 0, "channel": "BHZ", "availability": 1.0}
        for index, station in enumerate(station_headers)
    ]
    return {
        "schema": "skyview-ambient-noise", "benchmark": False, "seed": None,
        "sampleRate": sample_rate, "startTime": None, "stations": stations, "traces": traces,
    }


def _distance(a: dict[str, Any], b: dict[str, Any]) -> float:
    return math.hypot(float(a["x"]) - float(b["x"]), float(a["y"]) - float(b["y"]))


def _pairs(stations: list[dict[str, Any]], options: dict[str, Any]) -> list[dict[str, Any]]:
    result = []
    for left_index, left in enumerate(stations):
        for right in stations[left_index + 1:]:
            distance = _distance(left, right)
            if 1.5 <= distance <= 9.5:
                result.append({"id": f'{left["id"]}-{right["id"]}', "a": left["id"], "b": right["id"],
                               "stationA": left, "stationB": right, "distance": distance})
    return sorted(result, key=lambda item: item["distance"])[:int(options["limit"])]


def _pair_correlations(network: dict[str, Any], options: dict[str, Any]) -> list[dict[str, Any]]:
    sample_rate = float(network["sampleRate"])
    processed = {station["id"]: _preprocess(network["traces"][station["id"]], sample_rate, options) for station in network["stations"]}
    max_lag_seconds = float(options["maxLagSeconds"])
    result = []
    for pair in _pairs(network["stations"], options):
        correlation = _correlation(processed[pair["a"]], processed[pair["b"]], -max_lag_seconds * sample_rate, max_lag_seconds * sample_rate)
        plausible_min = max(1, math.floor(pair["distance"] / float(options["maxVelocity"]) * sample_rate))
        plausible_max = min(max_lag_seconds * sample_rate, math.ceil(pair["distance"] / float(options["minVelocity"]) * sample_rate))
        positive = _peak(correlation, plausible_min, plausible_max)
        negative = _peak(correlation, -plausible_max, -plausible_min)
        lag = positive["lag"] if abs(positive["value"]) >= abs(negative["value"]) else abs(negative["lag"])
        peak = max(abs(positive["value"]), abs(negative["value"]))
        side = [value for lag_value, value in zip(correlation["lags"], correlation["values"], strict=True) if abs(lag_value) > plausible_max * 0.8]
        noise = _std(side) or 0.001
        symmetry = min(abs(positive["value"]), abs(negative["value"])) / max(0.001, peak)
        result.append({
            **pair, "correlation": correlation, "peakLagSeconds": lag / sample_rate,
            "apparentVelocity": pair["distance"] / (lag / sample_rate) if lag else None,
            "snr": peak / noise, "symmetry": symmetry,
            "accepted": peak / noise >= float(options["minSnr"]) and symmetry >= float(options["minSymmetry"]),
        })
    return result


def _spectrum(values: list[float], sample_rate: float, bins: int = 75) -> list[dict[str, float]]:
    data = _taper(_detrend(values), 0.08)
    count = len(data)
    result = []
    for k in range(1, min(count // 2, bins) + 1):
        real = sum(value * math.cos(-2 * math.pi * k * index / count) for index, value in enumerate(data))
        imaginary = sum(value * math.sin(-2 * math.pi * k * index / count) for index, value in enumerate(data))
        result.append({"frequency": k * sample_rate / count, "power": (real * real + imaginary * imaginary) / count})
    return result


def _dispersion(network: dict[str, Any], pair_results: list[dict[str, Any]], options: dict[str, Any]) -> list[dict[str, Any]]:
    sample_rate = float(network["sampleRate"])
    result = []
    for pair in pair_results:
        picks = []
        for period in [2, 3, 4, 5, 6, 8]:
            frequency = 1 / period
            low = max(0.03, frequency * 0.72)
            high = min(sample_rate * 0.45, frequency * 1.35)
            left = _bandpass(_preprocess(network["traces"][pair["a"]], sample_rate, {**options, "normalization": "none", "clipSigma": 0}), low, high, sample_rate)
            right = _bandpass(_preprocess(network["traces"][pair["b"]], sample_rate, {**options, "normalization": "none", "clipSigma": 0}), low, high, sample_rate)
            min_lag = max(1, math.floor(pair["distance"] / float(options["maxVelocity"]) * sample_rate))
            max_lag = max(min_lag + 1, math.ceil(pair["distance"] / float(options["minVelocity"]) * sample_rate))
            correlation = _correlation(left, right, min_lag, max_lag)
            peak = _peak(correlation, min_lag, max_lag)
            velocity = pair["distance"] / (peak["lag"] / sample_rate) if peak["lag"] else None
            side = [value for lag_value, value in zip(correlation["lags"], correlation["values"], strict=True) if abs(lag_value - peak["lag"]) > sample_rate]
            snr = abs(peak["value"]) / (_std(side) or 0.001)
            picks.append({
                "period": period, "velocity": velocity, "lagSeconds": peak["lag"] / sample_rate,
                "amplitude": peak["value"], "snr": snr,
                "accepted": bool(velocity and float(options["minVelocity"]) <= velocity <= float(options["maxVelocity"]) and snr >= float(options["minDispersionSnr"])),
            })
        result.append({"pairId": pair["id"], "a": pair["a"], "b": pair["b"], "distance": pair["distance"], "picks": picks})
    return result


def _grid(stations: list[dict[str, Any]], nx: int, ny: int) -> dict[str, Any]:
    xs = [float(station["x"]) for station in stations]
    ys = [float(station["y"]) for station in stations]
    min_x, max_x = min(xs) - 0.4, max(xs) + 0.4
    min_y, max_y = min(ys) - 0.4, max(ys) + 0.4
    return {"nx": nx, "ny": ny, "minX": min_x, "maxX": max_x, "minY": min_y, "maxY": max_y,
            "dx": (max_x - min_x) / nx, "dy": (max_y - min_y) / ny}


def _ray_weights(grid: dict[str, Any], left: dict[str, Any], right: dict[str, Any]) -> list[float]:
    weights = [0.0] * (grid["nx"] * grid["ny"])
    for index in range(80):
        amount = (index + 0.5) / 80
        x = float(left["x"]) + (float(right["x"]) - float(left["x"])) * amount
        y = float(left["y"]) + (float(right["y"]) - float(left["y"])) * amount
        ix = max(0, min(grid["nx"] - 1, math.floor((x - grid["minX"]) / grid["dx"])))
        iy = max(0, min(grid["ny"] - 1, math.floor((y - grid["minY"]) / grid["dy"])))
        weights[iy * grid["nx"] + ix] += 1 / 80
    return weights


def _neighbours(index: int, grid: dict[str, Any]) -> list[int]:
    x, y = index % grid["nx"], index // grid["nx"]
    points = [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)]
    return [iy * grid["nx"] + ix for ix, iy in points if 0 <= ix < grid["nx"] and 0 <= iy < grid["ny"]]


def _invert(stations: list[dict[str, Any]], observations: list[dict[str, Any]], options: dict[str, Any]) -> dict[str, Any]:
    period = float(options["period"])
    grid = _grid(stations, int(options["nx"]), int(options["ny"]))
    station_map = {station["id"]: station for station in stations}
    selected = []
    for entry in observations:
        pick = next((item for item in entry["picks"] if float(item["period"]) == period and item["accepted"]), None)
        if pick:
            selected.append({**entry, "velocity": pick["velocity"], "snr": pick["snr"]})
    reference = float(options.get("referenceVelocity") or (_mean([item["velocity"] for item in selected]) if selected else 2))
    rows = [_ray_weights(grid, station_map[item["a"]], station_map[item["b"]]) for item in selected]
    data = [1 / item["velocity"] - 1 / reference for item in selected]
    model = [0.0] * (grid["nx"] * grid["ny"])
    coverage = [0.0] * len(model)
    for row in rows:
        for index, value in enumerate(row):
            coverage[index] += value
    for _ in range(int(options["iterations"])):
        gradient = [float(options["damping"]) * value for value in model]
        for row_index, row in enumerate(rows):
            residual = sum(weight * model[index] for index, weight in enumerate(row)) - data[row_index]
            for index, weight in enumerate(row):
                if weight:
                    gradient[index] += weight * residual
        for index, value in enumerate(model):
            nearby = _neighbours(index, grid)
            if nearby:
                gradient[index] += float(options["smoothing"]) * (value - _mean([model[other] for other in nearby]))
        divisor = max(1, len(selected))
        for index in range(len(model)):
            model[index] -= 0.42 * gradient[index] / divisor
    velocities = [None if coverage[index] < 0.02 else 1 / max(0.05, 1 / reference + value) for index, value in enumerate(model)]
    residuals = [sum(weight * model[index] for index, weight in enumerate(row)) - data[row_index] for row_index, row in enumerate(rows)]
    return {
        "period": period, "grid": grid, "referenceVelocity": reference, "velocities": velocities,
        "anomalies": [None if value is None else (value / reference - 1) * 100 for value in velocities],
        "coverage": coverage, "observations": len(selected), "rms": math.sqrt(_mean([value * value for value in residuals])), "model": model,
    }


def _checkerboard(stations: list[dict[str, Any]], observations: list[dict[str, Any]], options: dict[str, Any]) -> dict[str, Any]:
    base = _invert(stations, observations, options)
    target = [(-0.08 if ((index % base["grid"]["nx"]) // 2 + (index // base["grid"]["nx"]) // 2) % 2 else 0.08) for index in range(base["grid"]["nx"] * base["grid"]["ny"])]
    station_map = {station["id"]: station for station in stations}
    synthetic = []
    for index, entry in enumerate(observations):
        weights = _ray_weights(base["grid"], station_map[entry["a"]], station_map[entry["b"]])
        slowness = sum(weight / (base["referenceVelocity"] * (1 + target[cell])) for cell, weight in enumerate(weights))
        velocity = 1 / slowness if slowness else base["referenceVelocity"]
        synthetic.append({**entry, "picks": [{"period": options["period"], "velocity": velocity * (1 + math.sin(index * 2.17) * 0.006), "snr": 8, "accepted": True}]})
    recovered = _invert(stations, synthetic, {**options, "referenceVelocity": base["referenceVelocity"]})
    recovered_fraction = [0 if value is None else value / 100 for value in recovered["anomalies"]]
    target_mean, recovered_mean = _mean(target), _mean(recovered_fraction)
    covariance = _mean([(value - target_mean) * (recovered_fraction[index] - recovered_mean) for index, value in enumerate(target)])
    correlation = covariance / max(1e-12, _std(target) * _std(recovered_fraction))
    return {
        "target": [value * 100 for value in target], "recovered": recovered["anomalies"],
        "correlation": correlation, "rms": math.sqrt(_mean([(value - recovered_fraction[index]) ** 2 for index, value in enumerate(target)])),
        "grid": base["grid"], "coverage": recovered["coverage"],
    }


def _quality(network: dict[str, Any], pairs: list[dict[str, Any]], dispersion: list[dict[str, Any]], tomography: dict[str, Any] | None) -> dict[str, Any]:
    picks = [pick for entry in dispersion for pick in entry["picks"]]
    return {
        "stationAvailability": _mean([station["availability"] for station in network["stations"]]),
        "pairAcceptance": sum(bool(pair["accepted"]) for pair in pairs) / len(pairs) if pairs else 0,
        "dispersionAcceptance": sum(bool(pick["accepted"]) for pick in picks) / len(picks) if picks else 0,
        "medianSnr": _median([pair["snr"] for pair in pairs]),
        "medianSymmetry": _median([pair["symmetry"] for pair in pairs]),
        "coverage": sum(value >= 0.02 for value in tomography["coverage"]) / len(tomography["coverage"]) if tomography else 0,
        "tomographyRms": tomography["rms"] if tomography else None,
    }


def _number(value: Any, fallback: float, minimum: float, maximum: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = fallback
    return min(maximum, max(minimum, parsed))


def _settings(payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    source = payload.get("options") if isinstance(payload.get("options"), dict) else {}
    tomo_source = payload.get("tomographyOptions") if isinstance(payload.get("tomographyOptions"), dict) else {}
    options = {
        **DEFAULT_OPTIONS,
        "lowHz": _number(source.get("lowHz"), 0.1, 0.01, 10),
        "highHz": _number(source.get("highHz"), 1.05, 0.02, 20),
        "taper": _number(source.get("taper"), 0.05, 0, 0.25),
        "normalization": source.get("normalization") if source.get("normalization") in {"ramn", "onebit", "none"} else "ramn",
        "normalizationWindow": _number(source.get("normalizationWindow"), 5, 0.2, 60),
        "clipSigma": _number(source.get("clipSigma"), 4, 0, 20),
        "maxLagSeconds": _number(source.get("maxLagSeconds"), 10, 1, 120),
        "minVelocity": _number(source.get("minVelocity"), 0.7, 0.1, 10),
        "maxVelocity": _number(source.get("maxVelocity"), 4, 0.2, 20),
        "minSnr": _number(source.get("minSnr"), 1.8, 0, 100),
        "minSymmetry": _number(source.get("minSymmetry"), 0.15, 0, 1),
        "limit": round(_number(source.get("limit"), 18, 1, 36)),
        "minDispersionSnr": _number(source.get("minDispersionSnr"), 1.4, 0, 100),
    }
    tomography = {
        "period": _number(tomo_source.get("period"), 4, 2, 8),
        "nx": round(_number(tomo_source.get("nx"), 10, 4, 24)),
        "ny": round(_number(tomo_source.get("ny"), 8, 4, 24)),
        "damping": _number(tomo_source.get("damping"), 0.18, 0, 5),
        "smoothing": _number(tomo_source.get("smoothing"), 0.22, 0, 5),
        "iterations": round(_number(tomo_source.get("iterations"), 140, 10, 1000)),
    }
    if options["highHz"] <= options["lowHz"]:
        raise ToolError("高截止频率必须大于低截止频率")
    if options["maxVelocity"] <= options["minVelocity"]:
        raise ToolError("最大速度必须大于最小速度")
    return options, tomography


def _csv_exports(network: dict[str, Any], dispersion: list[dict[str, Any]]) -> tuple[str, str]:
    station_output = io.StringIO()
    station_writer = csv.writer(station_output, lineterminator="\r\n")
    station_writer.writerow(["station", "x_km", "y_km", "elevation_m", "channel", "availability"])
    for station in network["stations"]:
        station_writer.writerow([station["id"], station["x"], station["y"], station["elevation"], station["channel"], station["availability"]])
    dispersion_output = io.StringIO()
    dispersion_writer = csv.writer(dispersion_output, lineterminator="\r\n")
    dispersion_writer.writerow(["pair", "station_a", "station_b", "distance_km", "period_s", "velocity_km_s", "snr", "accepted"])
    for entry in dispersion:
        for pick in entry["picks"]:
            dispersion_writer.writerow([entry["pairId"], entry["a"], entry["b"], entry["distance"], pick["period"], pick["velocity"], pick["snr"], pick["accepted"]])
    return station_output.getvalue(), dispersion_output.getvalue()


def run_ambient_noise(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    # Preserve the first control-plane contract while the React parity surface
    # moves to the full project-shaped payload below.
    if action == "correlate" and ("left" in payload or "right" in payload):
        left = parse_numbers(payload.get("left"), key="left", minimum=8)
        right = parse_numbers(payload.get("right"), key="right", minimum=8)
        if len(left) != len(right):
            raise ToolError("两条波形长度必须一致")
        max_lag = round(_number(payload.get("maxLag"), min(100, len(left) // 3), 1, len(left) - 2))
        left_mean, right_mean = _mean(left), _mean(right)
        correlation = _correlation([value - left_mean for value in left], [value - right_mean for value in right], -max_lag, max_lag)
        peak = max(zip(correlation["lags"], correlation["values"], strict=True), key=lambda item: (abs(item[1]), -abs(item[0])))
        return {
            "samples": len(left), "peakLag": int(peak[0]), "peakCorrelation": round(peak[1], 6),
            "correlation": [{"lag": int(lag), "value": round(value, 6)} for lag, value in zip(correlation["lags"], correlation["values"], strict=True)],
        }
    stages = {"load-sample", "preprocess", "correlate", "dispersion", "tomography", "checkerboard", "run-all"}
    if action not in stages:
        raise ToolError("不支持的背景噪声成像操作")
    options, tomography_options = _settings(payload)
    source = str(payload.get("waveformCsv") or "").strip()
    network = _parse_csv(source) if source else _synthetic_network(round(_number(payload.get("seed"), 20260809, 1, 2**31 - 1)))
    sample_rate = float(network["sampleRate"])
    selected_station = str(payload.get("selectedStation") or network["stations"][0]["id"])
    if selected_station not in network["traces"]:
        selected_station = network["stations"][0]["id"]
    raw = network["traces"][selected_station]
    processed = _preprocess(raw, sample_rate, options)
    spectrum = _spectrum(raw, sample_rate)
    station_previews = {
        station["id"]: {
            "raw": network["traces"][station["id"]],
            "processed": _preprocess(network["traces"][station["id"]], sample_rate, options),
            "spectrum": _spectrum(network["traces"][station["id"]], sample_rate),
        }
        for station in network["stations"]
    }
    pair_results: list[dict[str, Any]] = []
    dispersion: list[dict[str, Any]] = []
    tomography: dict[str, Any] | None = None
    checkerboard: dict[str, Any] | None = None
    order = ["load-sample", "preprocess", "correlate", "dispersion", "tomography", "checkerboard", "run-all"]
    target = order.index(action)
    if target >= order.index("correlate"):
        pair_results = _pair_correlations(network, options)
    if target >= order.index("dispersion"):
        dispersion = _dispersion(network, pair_results, options)
    if target >= order.index("tomography"):
        tomography = _invert(network["stations"], dispersion, tomography_options)
    if target >= order.index("checkerboard"):
        checkerboard = _checkerboard(network["stations"], dispersion, tomography_options)
    quality = _quality(network, pair_results, dispersion, tomography)
    station_csv, dispersion_csv = _csv_exports(network, dispersion)
    methods = (
        f"数据来源：{'确定性合成连续噪声基准' if network['benchmark'] else '用户导入多道 CSV'}\n"
        f"台站数：{len(network['stations'])}\n采样率：{sample_rate} Hz\n"
        f"预处理：去均值、线性去趋势、{options['taper']} 余弦渐消、{options['lowHz']}-{options['highHz']} Hz 近似带通、{options['normalization']} 时域归一化\n"
        f"互相关：最大延迟 ±{options['maxLagSeconds']}s，速度窗 {options['minVelocity']}-{options['maxVelocity']} km/s\n"
        f"频散：2/3/4/5/6/8s 窄带互相关峰值，SNR≥{options['minDispersionSnr']}\n"
        f"层析：{tomography_options['nx']}×{tomography_options['ny']} 网格，阻尼 {tomography_options['damping']}，平滑 {tomography_options['smoothing']}，迭代 {tomography_options['iterations']}\n"
        "验证：射线覆盖与棋盘恢复测试。"
    )
    return {
        "schema": "skyview-ambient-noise-results", "version": 2, "stage": action,
        "network": network, "selectedStation": selected_station,
        "preview": {"raw": raw, "processed": processed, "spectrum": spectrum},
        "stationPreviews": station_previews,
        "pairResults": pair_results, "dispersion": dispersion, "tomography": tomography,
        "checkerboard": checkerboard, "quality": quality,
        "options": options, "tomographyOptions": tomography_options,
        "exports": {"stationCsv": station_csv, "dispersionCsv": dispersion_csv, "methodsText": methods},
        "limitations": [
            "近似带通用于流程复核，不替代零相位专业滤波",
            "CSV 导入未自动移除仪器响应",
            "地质结论需使用真实元数据和独立地震学软件复算",
        ],
    }
