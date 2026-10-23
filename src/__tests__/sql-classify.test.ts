/**
 * Classifying raw SQL by its text. Each classifier must err on the safe side;
 * the cases below include the ways text can mislead (nested comments, quoted
 * keywords, control flow that skips a trailing statement).
 */
import { describe, expect, it } from "vitest";

import {
  endsTransaction,
  isReadOnlySql,
  mayChangeIdentity,
  mayCreateTempTable,
  mayLeaveSessionState
} from "../sql-classify.js";

describe("isReadOnlySql", () => {
  it.each([
    "select 1",
    "  SELECT [a] FROM [t] WHERE [b] = 'x'",
    "SET ROWCOUNT 10\nselect * from [t]\nSET ROWCOUNT 0",
    "select * from [t] where [x] = 'insert into y'",
    "select [update] from [delete]",
    "select 1 -- drop table t",
    "select 1 /* outer /* inner */ still a comment */",
    "select [is_deleted] from t"
  ])("accepts %j", sql => {
    expect(isReadOnlySql(sql)).toBe(true);
  });

  it.each([
    "insert into [t] values (1)",
    "update [t] set [a] = 1",
    "delete from [t]",
    "select * into [t2] from [t]",
    "select * from [t] for update",
    "select 1\ninsert into t values (1)",
    "exec sp_foo",
    "sp_foo",
    "set nocount on select 1",
    "select 1; drop table t",
    "begin tran select 1",
    "with x as (select 1) delete from t",
    // ASE comments nest: the server ends this comment at the second */ and
    // runs the DELETE; the quote inside the comment is not a string.
    "select 1 /* outer /* inner */ ' */ delete from t -- '",
    "select 1 /* unterminated",
    "select 'unterminated",
    "select [unterminated"
  ])("rejects %j", sql => {
    expect(isReadOnlySql(sql)).toBe(false);
  });
});

describe("mayLeaveSessionState", () => {
  it.each([
    "select 1",
    "insert into [t] ([a]) values (1)\nSELECT @@identity",
    "update [t] set [a] = 1",
    "update [t] set [transaction] = 1",
    "delete from [t] where [a] = 'commit tran'",
    "select 1 -- exec sp_foo",
    "if exists (select 1 from t) begin select 2 end"
  ])("needs no reset after %j", sql => {
    expect(mayLeaveSessionState(sql)).toBe(false);
  });

  it.each([
    "begin tran",
    "BEGIN TRANSACTION insert t values (1)",
    "save tran sp",
    "commit",
    "rollback tran",
    "exec sp_foo",
    "execute ('select 1')",
    "sp_foo 1, 2",
    "set rowcount 5",
    "set chained on",
    "set transaction isolation level 0",
    "SET ROWCOUNT 10\nselect * from [t]",
    "SET ROWCOUNT 10\nselect 1\nset rowcount 3\nselect 2\nSET ROWCOUNT 0",
    "select 1 /* unterminated",
    "use otherdb",
    "",
    "if 1 = 1 begin tran",
    // Text cannot prove the trailing reset runs: RETURN or an error skips it.
    "SET ROWCOUNT 10\nselect * from [t]\nSET ROWCOUNT 0",
    "SET ROWCOUNT 5\nselect 1\nreturn\nSET ROWCOUNT 0"
  ])("needs a reset after %j", sql => {
    expect(mayLeaveSessionState(sql)).toBe(true);
  });
});

describe("endsTransaction", () => {
  it.each([
    "commit",
    "commit tran",
    "COMMIT TRANSACTION",
    "commit work",
    "rollback",
    "rollback tran",
    "rollback transaction",
    "rollback work",
    // A statement after a bare ROLLBACK TRAN is not a savepoint name.
    "rollback tran\nselect 1",
    "rollback tran\ninsert into t values (1)",
    "insert into t values (1)\ncommit tran",
    "if @@error = 0 commit tran"
  ])("refuses %j", sql => {
    expect(endsTransaction(sql)).toBe(true);
  });

  it.each([
    "rollback tran sp1",
    "ROLLBACK TRANSACTION my_savepoint",
    "save tran sp1",
    "select 1",
    // Keywords inside literals, identifiers and comments are not statements.
    "select 'commit' as x",
    "select [commit] from t",
    "select 1 -- rollback",
    "select 1 /* commit tran */",
    "update t set [rollback] = 1"
  ])("allows %j", sql => {
    expect(endsTransaction(sql)).toBe(false);
  });
});

describe("mayChangeIdentity", () => {
  it.each(["setuser 'app'", "setuser", "select 1\nsetuser 'x'", "select 'unterminated"])(
    "flags %j",
    sql => {
      expect(mayChangeIdentity(sql)).toBe(true);
    }
  );

  it.each(["select 1", "select 'setuser' as x", "select [setuser] from t"])("passes %j", sql => {
    expect(mayChangeIdentity(sql)).toBe(false);
  });
});

describe("mayCreateTempTable", () => {
  it.each(["create table #t (v int)", "select 1 as v into #t", "insert into #t values (1)"])(
    "flags %j",
    sql => {
      expect(mayCreateTempTable(sql)).toBe(true);
    }
  );

  it.each(["select 1", "create table tempdb..t (v int)", "exec('create table t (v int)')"])(
    "passes %j",
    sql => {
      expect(mayCreateTempTable(sql)).toBe(false);
    }
  );
});
