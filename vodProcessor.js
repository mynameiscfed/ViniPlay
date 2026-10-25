// vodProcessor.js
const XtreamClient = require('./xtreamClient');

const yearFrom = (releaseDate, name) => {
    if (releaseDate) {
        const year = new Date(releaseDate).getFullYear();
        if (Number.isFinite(year)) return year;
    }
    const yearMatch = name && String(name).match(/\((\d{4})\)/);
    return yearMatch ? parseInt(yearMatch[1], 10) : null;
};

/**
 * Main function to refresh all VOD content for a given provider.
 * @param {object} store - The VOD store (see vodStore.js).
 * @param {object} provider - The provider object (id, name, xc_data).
 * @param {function} sendStatus - Function to send status updates to the client.
 * @param {string} userAgent - User agent for requests to the provider.
 */
async function refreshVodContent(store, provider, sendStatus = () => {}, userAgent) {
    console.log(`[VOD Processor] Starting VOD refresh for: ${provider.name}`);
    const scanStartTime = new Date().toISOString();

    let server_url, username, password;
    try {
        if (!provider.xc_data) {
            throw new Error('Provider object is missing xc_data.');
        }
        const xcInfo = JSON.parse(provider.xc_data);
        server_url = xcInfo.server;
        username = xcInfo.username;
        password = xcInfo.password;
        if (!server_url || !username || !password) {
            throw new Error('Missing server, username, or password within xc_data.');
        }
    } catch (parseError) {
        console.error(`[VOD Processor] Failed to parse XC credentials for provider ${provider.name}: ${parseError.message}`);
        sendStatus(`Failed to parse XC credentials for ${provider.name}`, 'error');
        return; // Stop processing this provider if credentials are bad
    }

    const client = new XtreamClient(server_url, username, password, userAgent);
    const providerId = provider.id;

    // --- 0. Process Categories ---
    const categoryMap = new Map();
    try {
        sendStatus(`Fetching VOD and Series categories for ${provider.name}...`, 'info');
        const vodCategories = await client.getVodCategories();
        const seriesCategories = await client.getSeriesCategories();

        const allCategories = {};
        if (vodCategories && Array.isArray(vodCategories)) {
            vodCategories.forEach(cat => allCategories[cat.category_id] = cat);
        }
        if (seriesCategories && Array.isArray(seriesCategories)) {
            seriesCategories.forEach(cat => allCategories[cat.category_id] = cat);
        }
        const combinedCategories = Object.values(allCategories).filter(cat => cat.category_id && cat.category_name);

        if (combinedCategories.length > 0) {
            console.log(`[VOD Processor] Fetched ${combinedCategories.length} combined VOD/Series categories from provider.`);
            sendStatus(`Processing ${combinedCategories.length} VOD/Series categories...`, 'info');

            await store.upsertCategories(combinedCategories.map(cat => ({ categoryId: cat.category_id, categoryName: cat.category_name })));
            combinedCategories.forEach(cat => categoryMap.set(String(cat.category_id), cat.category_name));
        }
    } catch (error) {
        console.error(`[VOD Processor] Category processing FAILED for ${provider.name}:`, error.message);
        sendStatus(`Category processing FAILED for ${provider.name}: ${error.message}`, 'error');
        return; // Stop if categories fail
    }

    // A kind of content is only cleaned up if its whole scan went through. Otherwise a failed or
    // empty response from the provider would look like "everything was removed".
    let moviesScanned = false;
    let seriesScanned = false;

    // --- 1. Process Movies ---
    try {
        sendStatus(`Fetching movies for ${provider.name}...`, 'info');
        const movies = await client.getVodStreams();

        if (movies && Array.isArray(movies)) {
            console.log(`[VOD Processor] Fetched ${movies.length} movies from provider.`);
            sendStatus(`Processing ${movies.length} movies...`, 'info');

            const rows = [];
            for (const movieData of movies) {
                const { name, plot, stream_icon, stream_id, container_extension, category_id } = movieData;
                if (!stream_id) continue;
                rows.push({
                    providerUniqueId: `movie_${providerId}_${stream_id}`,
                    name,
                    year: yearFrom(movieData.releaseDate, name),
                    description: plot,
                    logo: stream_icon,
                    categoryName: categoryMap.get(String(category_id)) || 'VOD',
                    streamId: stream_id,
                    containerExtension: container_extension
                });
            }
            await store.upsertMovies(providerId, rows, scanStartTime);
            moviesScanned = true;
        }
    } catch (error) {
        console.error(`[VOD Processor] Movie processing FAILED for ${provider.name}:`, error.message);
        sendStatus(`Movie processing FAILED for ${provider.name}: ${error.message}`, 'error');
    }

    // --- 2. Process Series ---
    try {
        sendStatus(`Fetching series for ${provider.name}...`, 'info');
        const series = await client.getSeries();

        if (series && Array.isArray(series)) {
            console.log(`[VOD Processor] Fetched ${series.length} series from provider.`);
            sendStatus(`Processing ${series.length} series...`, 'info');

            const rows = [];
            for (const seriesData of series) {
                const { name, plot, cover, series_id: external_series_id, category_id } = seriesData;
                if (!external_series_id) continue;
                rows.push({
                    providerUniqueId: `series_${providerId}_${external_series_id}`,
                    name,
                    year: yearFrom(seriesData.releaseDate, name),
                    description: plot,
                    logo: cover,
                    categoryName: categoryMap.get(String(category_id)) || 'Series',
                    externalSeriesId: external_series_id
                });
            }
            await store.upsertSeries(providerId, rows, scanStartTime);
            seriesScanned = true;
        }
    } catch (error) {
        console.error(`[VOD Processor] Series processing FAILED for ${provider.name}:`, error.message);
        sendStatus(`Series processing FAILED for ${provider.name}: ${error.message}`, 'error');
    }

    // --- 3. Cleanup Stale and Orphaned Content ---
    let cleanedUp = true;
    try {
        console.log(`[VOD Processor] Cleaning up stale VOD content for ${provider.name}...`);
        sendStatus(`Cleaning up old VOD entries for ${provider.name}...`, 'info');

        // Cached episodes are rebuilt on demand when a series is opened, so they go whenever the
        // series list was refreshed.
        const removed = await store.removeStale(providerId, scanStartTime, { movies: moviesScanned, series: seriesScanned, episodes: seriesScanned });
        if (removed.movies > 0) console.log(`[VOD Processor] Removed ${removed.movies} stale movie relations.`);
        if (removed.series > 0) console.log(`[VOD Processor] Removed ${removed.series} stale series relations.`);
        if (removed.episodes > 0) console.log(`[VOD Processor] Removed ${removed.episodes} stale episode relations.`);
        console.log(`[VOD Processor] VOD cleanup completed for: ${provider.name}`);
    } catch (error) {
        cleanedUp = false;
        console.error(`[VOD Processor] Cleanup FAILED for ${provider.name}:`, error.message);
        sendStatus(`Cleanup FAILED for ${provider.name}: ${error.message}`, 'error');
    }

    if (moviesScanned && seriesScanned && cleanedUp) {
        console.log(`[VOD Processor] VOD refresh completed for: ${provider.name}`);
        sendStatus(`VOD refresh successful for ${provider.name}.`, 'success');
    } else {
        console.warn(`[VOD Processor] VOD refresh for ${provider.name} finished with problems (movies: ${moviesScanned}, series: ${seriesScanned}, cleanup: ${cleanedUp}).`);
        sendStatus(`VOD refresh for ${provider.name} finished with problems. Existing entries were kept where the provider could not be read.`, 'warning');
    }
}

module.exports = { refreshVodContent };
