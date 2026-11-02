import type { RequestHandler } from './$types';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const URL = 'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions/Bus';

export const GET: RequestHandler = async ({ fetch }) => {
	try {
		const response = await fetch(URL);

		if (!response.ok) {
			throw new Error(`Translink returned ${response.status}`);
		}

		const buffer = new Uint8Array(await response.arrayBuffer());

		const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);

		const vehicles = feed.entity.flatMap((entity) => {
			const vehicle = entity.vehicle;
			const position = vehicle?.position;

			if (position?.latitude == null || position?.longitude == null) {
				return [];
			}

			return [
				{
					id: vehicle?.vehicle?.id ?? entity.id,
					latitude: position.latitude,
					longitude: position.longitude,
					bearing: Object.prototype.hasOwnProperty.call(position, 'bearing')
						? position.bearing
						: null,
					tripId: vehicle?.trip?.tripId ?? null,
					routeId: vehicle?.trip?.routeId ?? null
				}
			];
		});

		return Response.json(
			{ vehicles },
			{
				headers: {
					'Cache-Control': 'public, max-age=0, s-maxage=15, stale-while-revalidate=15'
				}
			}
		);
	} catch (error) {
		console.error('Failed to fetch Translink vehicles:', error);

		return Response.json({ error: 'Unable to fetch vehicles' }, { status: 502 });
	}
};
