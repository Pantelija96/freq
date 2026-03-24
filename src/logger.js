const winston = require('winston');
require('winston-daily-rotate-file');

const { combine, timestamp, printf, colorize } = winston.format;

const transport = new winston.transports.DailyRotateFile({
    filename: 'logs/combined-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '14d',
    zippedArchive: true
});

const errorTransport = new winston.transports.DailyRotateFile({
    filename: 'logs/error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    level: 'error',
    maxSize: '20m',
    maxFiles: '30d',
    zippedArchive: true
});

const logFormat = printf(({ level, message, timestamp, ...meta }) => {

    let metaString = '';

    if (Object.keys(meta).length > 0) {
        metaString = '\n' + JSON.stringify(meta, null, 2);
    }

    return `${timestamp} [${level}] ${message}${metaString}\n\n----------------------------------------\n\n`;
});

const logger = winston.createLogger({
    level: 'info',
    format: combine(
        timestamp(),
        logFormat
    ),
    transports: [
        transport,
        errorTransport,
        new winston.transports.Console({
            format: combine(
                colorize(),
                timestamp(),
                logFormat
            )
        })
    ]
});

module.exports = logger;