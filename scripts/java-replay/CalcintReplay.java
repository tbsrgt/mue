// SPDX-License-Identifier: AGPL-3.0-only
// Replays the CALCINT cases exported by scripts/export-cases.ts through the Java that
// `mue convert examples/banking` generated and javac compiled, and compares every output with
// the COBOL interpreter. Used by CI; exits with status 1 on the first differences.
import com.example.bank.Account;
import com.example.bank.SavingsInterestCalculation;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

public class CalcintReplay {
    public static void main(String[] args) throws Exception {
        List<String> lines = Files.readAllLines(Path.of(args[0]));
        String[] header = lines.get(0).split("\t", -1);
        int cases = 0;
        int failures = 0;
        for (String line : lines.subList(1, lines.size())) {
            if (line.isEmpty()) continue;
            String[] cell = line.split("\t", -1);
            Account account = new Account();
            SavingsInterestCalculation.CalcArea area = new SavingsInterestCalculation.CalcArea();
            for (int i = 0; i < header.length; i++) {
                if (header[i].startsWith("=")) continue;
                set(header[i], cell[i], account, area);
            }
            new SavingsInterestCalculation().run(account, area);
            cases++;
            for (int i = 0; i < header.length; i++) {
                if (!header[i].startsWith("=")) continue;
                String name = header[i].substring(1);
                String expected = cell[i];
                String actual = get(name, account, area);
                if (!expected.equals(actual)) {
                    failures++;
                    if (failures <= 20) System.out.printf("case %d: %s COBOL=%s Java=%s (%s)%n", cases, name, expected, actual, line);
                }
            }
        }
        System.out.printf("CALCINT on the compiled Java: %d cases, %d differences%n", cases, failures);
        if (cases == 0 || failures > 0) System.exit(1);
    }

    private static void set(String name, String value, Account account, SavingsInterestCalculation.CalcArea area) {
        switch (name) {
            case "ACCT-NUMBER" -> account.number = value.stripTrailing();
            case "ACCT-STATUS" -> account.status = value.stripTrailing();
            case "ACCT-BALANCE" -> account.balance = new BigDecimal(value);
            case "ACCT-RATE" -> account.rate = new BigDecimal(value);
            case "LK-DAYS" -> area.days = new BigDecimal(value);
            case "LK-INTEREST" -> area.interest = new BigDecimal(value);
            case "LK-RETURN-CODE" -> area.returnCode = value.stripTrailing();
            default -> throw new IllegalArgumentException("Unknown CALCINT field " + name);
        }
    }

    /** Same canonical format as the report: numbers at the scale of their PIC. */
    private static String get(String name, Account account, SavingsInterestCalculation.CalcArea area) {
        return switch (name) {
            case "ACCT-NUMBER" -> account.number;
            case "ACCT-STATUS" -> account.status;
            case "ACCT-BALANCE" -> account.balance.setScale(2, RoundingMode.UNNECESSARY).toPlainString();
            case "ACCT-RATE" -> account.rate.setScale(4, RoundingMode.UNNECESSARY).toPlainString();
            case "LK-DAYS" -> area.days.setScale(0, RoundingMode.UNNECESSARY).toPlainString();
            case "LK-INTEREST" -> area.interest.setScale(2, RoundingMode.UNNECESSARY).toPlainString();
            case "LK-RETURN-CODE" -> area.returnCode;
            default -> throw new IllegalArgumentException("Unknown CALCINT field " + name);
        };
    }
}
