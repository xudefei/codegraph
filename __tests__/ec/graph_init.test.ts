import {it, describe} from "vitest";
import CodeGraph, {isInitialized} from "../../src";
import * as path from 'path';
import * as fs from 'fs';

describe('issue #238 — ToolHandler reuses the default instance (#2)', () => {
    let dir: string;
    dir = '/Users/mac/project/mall/mall-admin';
    it('should', async () => {
        const resolvedRoot = path.resolve(dir);
        if (!fs.existsSync(resolvedRoot) || isInitialized(resolvedRoot)) {
            return
        }
        await CodeGraph.init(dir, {index: true});
    },10000000);
});
