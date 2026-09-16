PRAGMA foreign_keys = ON;

-- 历史账号补齐可识别的测试电话号码；已有号码保持不变。
UPDATE users
   SET phone='139' || SUBSTR('00000000' || CAST(rowid AS TEXT),-8,8),
       updated_at=CURRENT_TIMESTAMP
 WHERE TRIM(COALESCE(phone,''))='';

CREATE TRIGGER users_phone_required_insert
BEFORE INSERT ON users
WHEN TRIM(COALESCE(NEW.phone,''))=''
BEGIN
  SELECT RAISE(ABORT,'user phone required');
END;

CREATE TRIGGER users_phone_required_update
BEFORE UPDATE OF phone ON users
WHEN TRIM(COALESCE(NEW.phone,''))=''
BEGIN
  SELECT RAISE(ABORT,'user phone required');
END;
