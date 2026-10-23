/**
 * The row types the generator publishes are `z.infer` of its Zod schemas; the
 * tables it generates infer their own. Both describe the same columns, so they
 * must be identical — for every registry type, nullable or not, and for every
 * way an insert column can become optional.
 *
 * Checked by `tsc`. The fixture is kept equal to the generator's output by
 * `generated-fixture.test.ts`.
 */
import { describe, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import * as schema from "./fixtures/generated-schema.js";

describe("generated row types equal the table inference", () => {
  it("select", () => {
    expectTypeOf<z.infer<typeof schema.everyTypeSchema>>().toEqualTypeOf(
      schema.everyType.$inferSelect
    );
    expectTypeOf<z.infer<typeof schema.widthsSchema>>().toEqualTypeOf(schema.widths.$inferSelect);
    expectTypeOf<z.infer<typeof schema.defaultsSchema>>().toEqualTypeOf(
      schema.defaults.$inferSelect
    );
  });

  it("insert", () => {
    expectTypeOf<z.infer<typeof schema.everyTypeInsertSchema>>().toEqualTypeOf(
      schema.everyType.$inferInsert
    );
    expectTypeOf<z.infer<typeof schema.widthsInsertSchema>>().toEqualTypeOf(
      schema.widths.$inferInsert
    );
    expectTypeOf<z.infer<typeof schema.defaultsInsertSchema>>().toEqualTypeOf(
      schema.defaults.$inferInsert
    );
  });
});
