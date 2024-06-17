import * as cp from 'child_process'
import axios from 'axios'
import {getAccessToken} from './account'
import {outputChannel} from '../../extension'

export enum RESTMethod {
    DELETE = 'delete',
    GET = 'get',
    HEAD = 'head',
    OPTIONS = 'options',
    PATCH = 'patch',
    POST = 'post',
    PUT = 'put',
}

// NOTE: Requesting with az cli will bring some problems, so we use axios instead.
// export async function request(method: RESTMethod, uri: string, body?: any, headers?: {[key: string]: string}) {
//     let bodyStr = body ? JSON.stringify(body) : undefined;
//     let headersStr = headers ? JSON.stringify(headers) : undefined;
//     if (!uri.startsWith('\"') && !uri.endsWith('\"')) uri = `"${uri}"`;
//     let args = ['rest',
//         '--method', method,
//         '--uri', uri,
//     ];
//     if (bodyStr) args.push('--body', `"${bodyStr.replaceAll(`'`, `\\'`).replaceAll(`"`, `'`)}"`);
//     if (headersStr) args.push('--headers', `"${headersStr.replaceAll(`'`, `\\'`).replaceAll(`"`, `'`)}"`);
//     outputChannel.appendLine('[CMD] > az ' + args.join(' '));
//     return new Promise<any>((resolve, reject) => {
//         cp.exec('az ' + args.join(' '), {}, (error, stdout, stderr) => {
//             if (stdout) {
//                 outputChannel.appendLine('[CMD OUT] ' + stdout);
//                 resolve(JSON.parse(stdout));
//             }
//             if (stderr) {
//                 outputChannel.appendLine('[CMD ERR] ' + stderr);
//                 reject(stderr);
//             }
//             if (error) {
//                 outputChannel.appendLine('[CMD ERR] ' + error.message);
//                 reject(error.message);
//             }
//         });
//     });
// }

export async function request(method: RESTMethod, uri: string, body?: any, headers?: {[key: string]: string}) {
    if (!headers) headers = {};
    if (!headers.hasOwnProperty('Authorization')) {
        headers['Authorization'] = `Bearer ${await getAccessToken()}`;
    }
    if (!headers.hasOwnProperty('Content-Type')) {
        headers['Content-Type'] = 'application/json';
    }
    outputChannel.appendLine(`[REST] > ${method.toUpperCase()} ${uri} ${JSON.stringify(body)} ${JSON.stringify(headers)}`);
    let response = await axios.request({
        method: method,
        url: uri,
        baseURL: 'https://management.azure.com',
        data: body,
        headers: headers,
    });
    if (response.status < 200 || response.status >= 300) {
        outputChannel.appendLine(`[REST ERR] ${response.status} ${response.statusText}`);
        throw response.data;
    }
    outputChannel.appendLine(`[REST OUT] ${JSON.stringify(response.data)}`);
    return response.data;
}

export async function batchRequest(requests: {httpMethod: RESTMethod, relativeUrl: string, content?: any}[]) {
    let responses = await request(
        RESTMethod.POST,
        '/batch?api-version=2020-06-01',
        {requests: requests}
    );
    return responses.responses;
}
