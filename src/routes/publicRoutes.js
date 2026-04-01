const fs = require('fs/promises');
const path = require('path');
const express = require('express');

const router = express.Router();

const APK_DIR = path.resolve(__dirname, '../../docs/apk');
const DOCS_DIR = path.resolve(__dirname, '../../docs');

router.get('/apk/latest', async (req, res) => {
    try {
        const entries = await fs.readdir(APK_DIR, { withFileTypes: true });
        const apkFiles = [];

        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.apk')) {
                continue;
            }

            const fullPath = path.join(APK_DIR, entry.name);
            const stats = await fs.stat(fullPath);
            apkFiles.push({
                name: entry.name,
                fullPath,
                modifiedAt: stats.mtimeMs
            });
        }

        if (!apkFiles.length) {
            return res.status(404).json({ error: 'No APK file is currently available.' });
        }

        apkFiles.sort((a, b) => b.modifiedAt - a.modifiedAt);
        return res.download(apkFiles[0].fullPath, apkFiles[0].name);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return res.status(404).json({ error: 'APK directory not found.' });
        }

        return res.status(500).json({ error: 'Failed to download APK.' });
    }
});

router.get('/docs/latest-pdf', async (req, res) => {
    try {
        const entries = await fs.readdir(DOCS_DIR, { withFileTypes: true });
        const pdfFiles = [];

        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.pdf')) {
                continue;
            }

            const fullPath = path.join(DOCS_DIR, entry.name);
            const stats = await fs.stat(fullPath);
            pdfFiles.push({
                name: entry.name,
                fullPath,
                modifiedAt: stats.mtimeMs
            });
        }

        if (!pdfFiles.length) {
            return res.status(404).json({ error: 'No PDF file is currently available.' });
        }

        pdfFiles.sort((a, b) => b.modifiedAt - a.modifiedAt);
        return res.sendFile(pdfFiles[0].fullPath, {
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `inline; filename="${pdfFiles[0].name}"`
            }
        });
    } catch (error) {
        if (error.code === 'ENOENT') {
            return res.status(404).json({ error: 'Documents directory not found.' });
        }

        return res.status(500).json({ error: 'Failed to open PDF document.' });
    }
});

module.exports = router;
