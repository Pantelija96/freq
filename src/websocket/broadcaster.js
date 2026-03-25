const broadcastToDashboard = (data, dashboardClients) => {
    if (!dashboardClients || !dashboardClients.forEach) {
        return;
    }
    const msg = JSON.stringify(data);
    dashboardClients.forEach(client => {
        if (client && client.readyState === 1) {
            try {
                client.send(msg);
            } catch (e) {}
        }
    });
};

module.exports = { broadcastToDashboard };
