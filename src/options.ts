import { Action, RoutingControllersOptions } from '@benjd90/routing-controllers';
import n9NodeLog from '@neo9/n9-node-log';
import { N9Error } from '@neo9/n9-node-utils';
import * as Sentry from '@sentry/node';
import * as appRootDir from 'app-root-dir';
import { ValidatorOptions } from 'class-validator';
import * as express from 'express';
import * as morgan from 'morgan';
import { join } from 'path';

import { ErrorHandler } from './middleware/error-handler.interceptor';
import { PrometheusInterceptor } from './middleware/prometheus.interceptor';
import { SentryRequestInterceptor } from './middleware/sentry-request.interceptor';
import { SentryTracingInterceptor } from './middleware/sentry-tracing.interceptor';
import { SessionLoaderInterceptor } from './middleware/session-loader.interceptor';
import { N9NodeRouting } from './models/routing.models';
import * as Utils from './utils';

function applyLogsOptionsDefaults(
	options: N9NodeRouting.Options,
	environment: Utils.Environment,
): void {
	// If enableLogFormatJSON is provided, we use it's value.
	// Otherwise, we activate the plain logs for development env and JSON logs for other environments
	options.enableLogFormatJSON =
		typeof options.enableLogFormatJSON === 'boolean'
			? options.enableLogFormatJSON
			: environment !== 'development';
	// If log if given, add a namespace
	if (options.log) {
		if (
			!(options.log as any).name.endsWith('n9-node-routing') ||
			(options.log as any).options.formatJSON !== options.enableLogFormatJSON
		) {
			options.log = options.log.module('n9-node-routing', {
				...(options.log as any)?.options,
				...options.logOptions,
				formatJSON: options.enableLogFormatJSON,
			});
		}
	} else {
		options.log = n9NodeLog('n9-node-routing', {
			...(options.log as any)?.options,
			...options.logOptions,
			formatJSON: options.enableLogFormatJSON,
		});
	}
}

function applyShutdownOptionsDefaults(options: N9NodeRouting.Options): void {
	options.shutdown = options.shutdown || {};
	options.shutdown.enableGracefulShutdown =
		typeof options.shutdown.enableGracefulShutdown === 'boolean'
			? options.shutdown.enableGracefulShutdown
			: true;
	options.shutdown.timeout =
		typeof options.shutdown.timeout === 'number' ? options.shutdown.timeout : 25 * 1_000;
	options.shutdown.waitDurationBeforeStop =
		typeof options.shutdown.waitDurationBeforeStop === 'number'
			? options.shutdown.waitDurationBeforeStop
			: 10_000;
}

function applyOpenApiOptionsDefaults(
	options: N9NodeRouting.Options,
	environment: Utils.Environment,
): void {
	if (!options.openapi) {
		options.openapi = {};
	}
	options.openapi.isEnable =
		typeof options.openapi.isEnable === 'boolean' ? options.openapi.isEnable : true;
	options.openapi.jsonUrl = options.openapi.jsonUrl || '/documentation.json';
	options.openapi.swaggerui = options.openapi.swaggerui || {
		...options.openapi.swaggerui,
		swaggerUrl: '../documentation.json',
	};
	options.openapi.generateDocumentationOnTheFly =
		typeof options.openapi.generateDocumentationOnTheFly === 'boolean'
			? options.openapi.generateDocumentationOnTheFly
			: environment === 'development';
}

function applyHttpOptionsDefaults(options: N9NodeRouting.Options): void {
	// Defaults options for routing-controller
	const defaultRoutingControllerOptions: RoutingControllersOptions = {
		defaults: {
			// with this option, null will return 404 by default
			nullResultCode: 404,
			// with this option, void or Promise<void> will return 204 by default
			undefinedResultCode: 204,
		},
		defaultErrorHandler: false,
		controllers: [`${options.path}/**/*.controller.*s`],
		plainToClassTransformOptions: {
			exposeDefaultValues: true,
		},
	};

	// Configure morgan
	morgan.token(
		'total-response-time',
		(req: express.Request, res: express.Response, digits: number = 3): string => {
			if (!(req as any)._startAt) {
				// missing request start time
				return;
			}

			// // calculate diff
			const reqStartTime = (req as any)._startAt;
			const resEndTime = process.hrtime();
			const ms = (resEndTime[0] - reqStartTime[0]) * 1e3 + (resEndTime[1] - reqStartTime[1]) * 1e-6;

			// return truncated value
			return ms.toFixed(digits);
		},
	);

	// Default options
	options.http = options.http || {};
	options.http.port = options.http.port || process.env.PORT || 5000;

	options.http.logLevel =
		typeof options.http.logLevel !== 'undefined'
			? options.http.logLevel
			: (tokens: morgan.TokenIndexer, req: express.Request, res: express.Response): string => {
					const formatLogInJSON: boolean = (global as any).n9NodeRoutingData.formatLogInJSON;

					if (formatLogInJSON) {
						return JSON.stringify({
							'method': tokens.method(req, res),
							'request-id': options.enableRequestId
								? `(${req.headers['x-request-id'] as string})`
								: '',
							'path': tokens.url(req, res),
							'status': tokens.status(req, res),
							'durationMs': Number.parseFloat(tokens['response-time'](req, res)),
							'totalDurationMs': Number.parseFloat(tokens['total-response-time'](req, res)),
							'content-length': tokens.res(req, res, 'content-length'),
						});
					}
					return [
						tokens.method(req, res),
						tokens.url(req, res),
						tokens.status(req, res),
						tokens['response-time'](req, res),
						'ms - ',
						tokens.res(req, res, 'content-length'),
					].join(' ');
			  };
	options.http.routingController = {
		...defaultRoutingControllerOptions,
		...options.http.routingController,
	};

	options.http.routingController.interceptors = [SessionLoaderInterceptor, ErrorHandler];
	if (options.sentry) {
		options.http.routingController.interceptors.push(SentryRequestInterceptor);
		if (
			options.sentry.additionalIntegrations?.find(
				(additionalIntegration) => additionalIntegration.kind === 'tracing',
			)
		) {
			options.log.module('sentry').info('Sentry tracing enabled');
			options.http.routingController.interceptors.push(SentryTracingInterceptor);
		}
	}
	if (options.prometheus) {
		options.http.routingController.interceptors.push(PrometheusInterceptor);
	}
	options.http.routingController.authorizationChecker = async (
		action: Action,
		// eslint-disable-next-line @typescript-eslint/require-await
	): Promise<boolean> => {
		if (!action.request.headers.session) {
			throw new N9Error('session-required', 401);
		}
		try {
			action.request.session = JSON.parse(action.request.headers.session);
		} catch (err) {
			throw new N9Error('session-header-is-invalid', 401);
		}
		if (!action.request.session.userId) {
			throw new N9Error('session-header-has-no-userId', 401);
		}
		return true;
	};
	options.http.routingController.validation = {
		whitelist: true,
		forbidNonWhitelisted: true,
	} as ValidatorOptions;
}

function applyPrometheusOptionsDefault(options: N9NodeRouting.Options): void {
	// Prometheus metrics
	if (options.prometheus) {
		options.prometheus.port =
			typeof options.prometheus.port === 'number' ? options.prometheus.port : 9101;
		options.prometheus.accuracies = options.prometheus.accuracies || ['s'];
	}
}

function applySentryOptionsDefault(
	options: N9NodeRouting.Options,
	environment: Utils.Environment,
): void {
	if (process.env.SENTRY_DSN) {
		if (!options.sentry) options.sentry = {};
		if (!options.sentry.initOptions) options.sentry.initOptions = {};
		options.sentry.initOptions.dsn = process.env.SENTRY_DSN;
	}
	if (options.sentry) {
		if (!options.sentry.initOptions?.dsn) {
			throw new N9Error('missing-sentry-dsn', 400, { options });
		}
		if (!options.sentry.forceCustomOptions) {
			if (!options.sentry.initOptions.integrations) {
				options.sentry.initOptions.integrations = [new Sentry.Integrations.Http({ tracing: true })];
			}
			if (!options.sentry.initOptions.environment) {
				options.sentry.initOptions.environment = environment;
			}
			if (Utils.isNil(options.sentry.initOptions.tracesSampleRate)) {
				options.sentry.initOptions.tracesSampleRate = 1;
			}
			if (!options.sentry.additionalIntegrations) {
				options.sentry.additionalIntegrations = [
					{
						kind: 'tracing',
					},
				];
			}
		}
	}
}

function applyAPMOptionsDefault(
	options: N9NodeRouting.Options,
	environment: Utils.Environment,
	appName: string,
): void {
	if (options.apm?.newRelicOptions?.licenseKey && !process.env.NEW_RELIC_LICENSE_KEY) {
		process.env.NEW_RELIC_LICENSE_KEY = options.apm.newRelicOptions.licenseKey;
	}
	if (process.env.NEW_RELIC_LICENSE_KEY && process.env.NEW_RELIC_ENABLED?.trim() !== 'false') {
		if (!options.apm) options.apm = {};
		options.apm.type = 'newRelic';
		if (!options.apm.newRelicOptions) options.apm.newRelicOptions = {};
		if (!options.apm.newRelicOptions.appName) {
			const env: string = process.env.NEW_RELIC_ENV_NAME || environment;
			options.apm.newRelicOptions.appName = [env, appName].join('-');
		}
		if (options.apm.newRelicOptions.appName && !process.env.NEW_RELIC_APP_NAME) {
			process.env.NEW_RELIC_APP_NAME = options.apm.newRelicOptions.appName;
		}
	}
}

export function applyDefaultValuesOnOptions(
	options: N9NodeRouting.Options,
	environment: Utils.Environment,
	appName: string,
): void {
	options.path = options.path || join(appRootDir.get(), 'src', 'modules');
	options.log = options.log || (global as any).log;
	options.hasProxy = typeof options.hasProxy === 'boolean' ? options.hasProxy : true;
	options.enableRequestId =
		typeof options.enableRequestId === 'boolean' ? options.enableRequestId : true;

	applyLogsOptionsDefaults(options, environment);
	applyShutdownOptionsDefaults(options);
	applyPrometheusOptionsDefault(options);
	applySentryOptionsDefault(options, environment);
	applyAPMOptionsDefault(options, environment, appName);

	applyOpenApiOptionsDefaults(options, environment);
	applyHttpOptionsDefaults(options);
}
