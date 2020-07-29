import ava, { Assertions } from 'ava';
import got from 'got';
import { join } from 'path';
import * as stdMock from 'std-mocks';
// tslint:disable-next-line:import-name
import N9NodeRouting from '../src';
import commons, { closeServer } from './fixtures/commons';

const MICRO_VALIDATE = join(__dirname, 'fixtures/micro-validate/');

ava('Read documentation', async (t: Assertions) => {
	stdMock.use({ print: commons.print });
	const { server } = await N9NodeRouting({
		path: MICRO_VALIDATE,
	});

	// Check /documentation
	const res = got({ url: 'http://localhost:5000/documentation.json' });
	const body = (await res.json()) as any;

	// Check logs
	stdMock.restore();
	stdMock.flush();
	t.is((await res).statusCode, 200);
	t.is(body.info.title, 'n9-node-routing');
	t.is(Object.keys(body.paths).length, 3);

	// Close server
	await closeServer(server);
});

// TODO: add test to get 404
// TODO: add test to check on production not accessible
// TODO: add test generated on the fly
