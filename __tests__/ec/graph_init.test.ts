import {it, describe} from "vitest";
import CodeGraph from "../../src";

describe('issue #238 — ToolHandler reuses the default instance (#2)', () => {
    let dir: string;
    dir = '/Users/mac/project/mall/mall-admin';
    it('should', async () => {
        await CodeGraph.init(dir, {index: true});
    },10000000);
});
