const pool = require('../config/db');
const logger = require('../utils/logger');

function compressToSegments(startTs, intervalMs, freqArray) {
    const segments = [];
    if (!Array.isArray(freqArray) || freqArray.length === 0) return segments;

    let i = 0;
    const n = freqArray.length;
    while (i < n) {
        const freq = Number(freqArray[i]) || 0;
        let j = i + 1;
        while (j < n && Number(freqArray[j]) === freq) j++;
        const segStart = startTs + BigInt(i * intervalMs);
        const segEnd   = startTs + BigInt(j * intervalMs);
        segments.push({ start: segStart, end: segEnd, freq });
        i = j;
    }
    return segments;
}

async function processFrequencyBatch(deviceId, payload) {
    const batchId = payload.batch_id;
    if (!batchId) return;

    try {
        const [existing] = await pool.execute(
            `SELECT 1 FROM processed_frequency_batches WHERE device_id=? AND batch_id=?`,
            [deviceId, batchId]
        );
        if (existing.length > 0) return;

        await pool.execute(
            `INSERT INTO processed_frequency_batches (batch_id, device_id, status) VALUES (?, ?, 'received')`,
            [batchId, deviceId]
        );

        const startTs = BigInt(payload.start_timestamp || 0);
        const endTs   = BigInt(payload.end_timestamp || 0);
        const intervalMs = Number(payload.interval || 250);

        const expectedSamples = Math.round(Number(endTs - startTs) / intervalMs) + 1;

        function normalizeFreqArray(freqArray, expected) {
            if (!Array.isArray(freqArray) || freqArray.length === 0) return new Array(expected).fill(0);
            if (freqArray.length === 1) return new Array(expected).fill(Number(freqArray[0]) || 0);

            const normalized = freqArray.map(f => {
                const num = Number(f);
                return isNaN(num) ? 0 : Math.round(num);
            });

            if (normalized.length > expected) return normalized.slice(0, expected);
            if (normalized.length < expected) {
                const last = normalized[normalized.length - 1] || 0;
                while (normalized.length < expected) normalized.push(last);
            }
            return normalized;
        }

        const smallFreq = normalizeFreqArray(payload.small_cores_frequency || [], expectedSamples);
        const bigFreq   = normalizeFreqArray(payload.big_cores_frequency || [], expectedSamples);

        const smallSegments = compressToSegments(startTs, intervalMs, smallFreq);
        const bigSegments   = compressToSegments(startTs, intervalMs, bigFreq);

        const allRows = [
            ...smallSegments.map(s => [deviceId, 'small', s.start, s.end, s.freq, batchId]),
            ...bigSegments.map(s => [deviceId, 'big', s.start, s.end, s.freq, batchId])
        ];

        if (allRows.length === 0) {
            await markBatchProcessed(deviceId, batchId, 0);
            return;
        }

        await pool.query(
            `INSERT IGNORE INTO cpu_frequency_segments 
             (device_id, core_type, segment_start, segment_end, frequency_khz, batch_id) VALUES ?`,
            [allRows]
        );

        await markBatchProcessed(deviceId, batchId, allRows.length);

        logger.info('frequency_batch_processed', {
            deviceId, batchId,
            durationSeconds: Number(endTs - startTs) / 1000,
            smallSegments: smallSegments.length,
            bigSegments: bigSegments.length,
            totalSegments: allRows.length
        });
    } catch (err) {
        logger.error('processFrequencyBatch_failed', { deviceId, batchId, error: err.message });
        await markBatchFailed(deviceId, batchId, err.message.substring(0,255)).catch(() => {});
    }
}

async function markBatchProcessed(deviceId, batchId, segmentsCount) {
    await pool.execute(
        `UPDATE processed_frequency_batches 
         SET status='processed', processed_at=CURRENT_TIMESTAMP(3), segments_count=?
         WHERE device_id=? AND batch_id=?`,
        [segmentsCount, deviceId, batchId]
    );
}

async function markBatchFailed(deviceId, batchId, errorMessage) {
    await pool.execute(
        `UPDATE processed_frequency_batches 
         SET status='failed', processed_at=CURRENT_TIMESTAMP(3), segments_count=?
         WHERE device_id=? AND batch_id=?`,
        [errorMessage, deviceId, batchId]
    );
}

module.exports = {
    processFrequencyBatch,
    compressToSegments,
    markBatchProcessed,
    markBatchFailed
};
