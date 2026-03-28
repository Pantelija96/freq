const FIXED_SESSION_MIN_DURATION_MS = 2000;

function buildFrequencyAnalytics(rows = [], crashes = []) {
    const sessions = buildCombinedSessions(rows);
    const fixedSessions = sessions.filter((session) => session.is_fixed);
    const totalObservedMs = sessions.reduce((sum, session) => sum + session.duration_ms, 0);
    const fixedTimeMs = fixedSessions.reduce((sum, session) => sum + session.duration_ms, 0);
    const fixedPercent = totalObservedMs > 0
        ? Number(((fixedTimeMs / totalObservedMs) * 100).toFixed(2))
        : 0;

    const crashesDuringFixed = crashes.filter((crash) =>
        fixedSessions.some((session) => isCrashInsideSession(crash.crash_time, session))
    );

    const crashesOutsideFixed = crashes.filter((crash) =>
        !fixedSessions.some((session) => isCrashInsideSession(crash.crash_time, session))
    );

    return {
        summary: {
            total_observed_ms: totalObservedMs,
            fixed_time_ms: fixedTimeMs,
            fixed_percent: fixedPercent,
            fixed_session_count: fixedSessions.length,
            crashes_during_fixed: crashesDuringFixed.length,
            crashes_outside_fixed: crashesOutsideFixed.length,
            top_small_fixed_freq_khz: getTopFrequencyByDuration(fixedSessions, 'small_frequency_khz'),
            top_big_fixed_freq_khz: getTopFrequencyByDuration(fixedSessions, 'big_frequency_khz')
        },
        sessions,
        fixedSessions,
        crashesDuringFixed,
        crashesOutsideFixed
    };
}

function buildCombinedSessions(rows) {
    const normalized = rows.map((row) => ({
        ...row,
        segment_start: Number(row.segment_start ?? row.ts_start),
        segment_end: Number(row.segment_end ?? row.ts_end),
        frequency_khz: Number(row.frequency_khz)
    })).filter((row) =>
        Number.isFinite(row.segment_start)
        && Number.isFinite(row.segment_end)
        && row.segment_end > row.segment_start
    );

    if (!normalized.length) {
        return [];
    }

    const smallSegments = normalized.filter((row) => row.core_type === 'small');
    const bigSegments = normalized.filter((row) => row.core_type === 'big');
    const boundaries = [...new Set(
        normalized.flatMap((row) => [row.segment_start, row.segment_end])
    )].sort((left, right) => left - right);

    const sessions = [];

    for (let index = 0; index < boundaries.length - 1; index += 1) {
        const start = boundaries[index];
        const end = boundaries[index + 1];
        if (end <= start) {
            continue;
        }

        const smallFrequency = findFrequencyAtTime(smallSegments, start);
        const bigFrequency = findFrequencyAtTime(bigSegments, start);

        if (smallFrequency === null && bigFrequency === null) {
            continue;
        }

        const current = {
            start_timestamp: start,
            end_timestamp: end,
            duration_ms: end - start,
            small_frequency_khz: smallFrequency,
            big_frequency_khz: bigFrequency
        };

        const previous = sessions[sessions.length - 1];
        if (
            previous
            && previous.small_frequency_khz === current.small_frequency_khz
            && previous.big_frequency_khz === current.big_frequency_khz
        ) {
            previous.end_timestamp = current.end_timestamp;
            previous.duration_ms += current.duration_ms;
        } else {
            sessions.push(current);
        }
    }

    return sessions.map((session, index) => ({
        id: index + 1,
        ...session,
        is_fixed: session.duration_ms >= FIXED_SESSION_MIN_DURATION_MS
            && (session.small_frequency_khz !== null || session.big_frequency_khz !== null)
    }));
}

function findFrequencyAtTime(segments, timestamp) {
    const match = segments.find((segment) =>
        segment.segment_start <= timestamp && segment.segment_end > timestamp
    );

    return match ? match.frequency_khz : null;
}

function isCrashInsideSession(crashTime, session) {
    const crashTimestamp = new Date(crashTime).getTime();
    if (!Number.isFinite(crashTimestamp)) {
        return false;
    }

    return crashTimestamp >= session.start_timestamp && crashTimestamp <= session.end_timestamp;
}

function getTopFrequencyByDuration(sessions, key) {
    const durations = new Map();

    sessions.forEach((session) => {
        const value = session[key];
        if (!Number.isFinite(value) || value === null) {
            return;
        }

        durations.set(value, (durations.get(value) || 0) + session.duration_ms);
    });

    let topFrequency = null;
    let topDuration = -1;
    durations.forEach((duration, frequency) => {
        if (duration > topDuration) {
            topDuration = duration;
            topFrequency = frequency;
        }
    });

    return topFrequency;
}

function formatDuration(durationMs) {
    if (!Number.isFinite(durationMs)) {
        return '-';
    }

    const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return [hours, minutes, seconds]
        .map((part) => String(part).padStart(2, '0'))
        .join(':');
}

module.exports = {
    FIXED_SESSION_MIN_DURATION_MS,
    buildFrequencyAnalytics,
    buildCombinedSessions,
    formatDuration
};
